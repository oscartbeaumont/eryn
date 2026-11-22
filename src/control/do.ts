/**
 * The control plane.
 *
 * One object owns identity: users, email login codes, browser sessions, and the
 * registry of Eryn servers. It deliberately knows nothing about agents, files,
 * or messaging, so a login does not wake a server's OpenCode host.
 */

import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";

import { capture, pseudonym } from "../analytics.ts";
import { codeHash, emailKey, loginCode, normaliseEmail } from "../auth/crypto.ts";
import { mailer } from "../auth/email.ts";
import { KEYS, log, sessionSecret } from "../config.ts";
import { AuthSessionSchema, LoginCodeSchema, ServerRefSchema, UserSchema } from "../core/schema.ts";
import { newId } from "../core/ids.ts";
import { recordStore } from "../core/store.ts";
import type { RecordStore } from "../core/store.ts";
import { body, failure, json } from "../core/http.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODE_TTL_MS = 10 * 60 * 1000;

const MAX_ATTEMPTS = 5;

const CODE_COOLDOWN_MS = 60 * 1000;

const RequestCodeSchema = Schema.Struct({ email: Schema.String });

const VerifyCodeSchema = Schema.Struct({ email: Schema.String, code: Schema.String });

const SessionRequestSchema = Schema.Struct({ id: Schema.String });

const CreateServerSchema = Schema.Struct({ userId: Schema.String, name: Schema.String });

const ListServersSchema = Schema.Struct({ userId: Schema.String });

const ServerIdSchema = Schema.Struct({ id: Schema.String });

const RenameServerSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	userId: Schema.String,
});

/** A short-lived code proving you can manage a Discord guild. */
const ClaimSchema = Schema.Struct({
	serverId: Schema.String,
	guildId: Schema.String,
	createdAt: Schema.Finite,
});

const ClaimPutSchema = Schema.Struct({ serverId: Schema.String, guildId: Schema.String });

const ClaimLookupSchema = Schema.Struct({ code: Schema.String });

const CLAIM_TTL_MS = 15 * 60 * 1000;

const CLAIM = "claim:";

/** Compare two hex digests without leaking how much of a prefix matched. */
function sameHash(left: string, right: string): boolean {
	let mismatch = left.length ^ right.length;

	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}

	return mismatch === 0;
}

/** A user-facing name, trimmed and bounded. */
function cleanName(value: string): string {
	return value.trim().replaceAll(/\s+/g, " ").slice(0, 80);
}

export class Control extends DurableObject<Env> {
	private readonly store: RecordStore;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.store = recordStore(state.storage, env.ENCRYPTION_KEY);
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;

		try {
			if (path === "/code" && request.method === "POST") return await this.requestCode(request);
			if (path === "/verify" && request.method === "POST") return await this.verifyCode(request);
			if (path === "/session" && request.method === "POST") return await this.session(request);
			if (path === "/logout" && request.method === "POST") return await this.logout(request);
			if (path === "/servers/create" && request.method === "POST") return await this.createServer(request);
			if (path === "/servers/list" && request.method === "POST") return await this.listServers(request);
			if (path === "/servers/rename" && request.method === "POST") return await this.renameServer(request);
			if (path === "/claim/put" && request.method === "POST") return await this.putClaim(request);
			if (path === "/claim/get" && request.method === "POST") return await this.getClaim(request);
			if (path === "/claim/drop" && request.method === "POST") return await this.dropClaim(request);
			return failure("Not found.", 404);
		} catch (error) {
			log("control", `route ${path} failed: ${String(error)}`);

			return failure("The control plane could not answer.", 500);
		}
	}

	private secret(): string {
		const value = sessionSecret(this.env);

		if (!value) throw new Error("SESSION_SECRET is not configured");
		return value;
	}

	/** Send a login code, refusing to spam an address. */
	private async requestCode(request: Request): Promise<Response> {
		const input = await body(request, RequestCodeSchema);

		if (input instanceof Response) return input;
		const email = normaliseEmail(input.email);

		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			return failure("Enter a valid email address.");
		}

		const emailHash = await emailKey(email);
		const key = KEYS.loginCode + emailHash;
		const previous = await this.store.plain(key, LoginCodeSchema);

		if (previous && Date.now() - previous.createdAt < CODE_COOLDOWN_MS) {
			return failure("A code was just sent. Wait a minute before asking for another.");
		}

		const code = loginCode();
		const hash = await codeHash(email, code, this.secret());
		const now = Date.now();

		await this.store.putPlain(key, LoginCodeSchema, {
			email,
			hash,
			expiresAt: now + CODE_TTL_MS,
			attempts: 0,
			createdAt: now,
		});

		const account = await this.store.plain(KEYS.user + emailHash, UserSchema);
		const sent = await mailer(this.env).send({ to: email, code });
		// A first-time address has no user id yet, so the request is attributed to
		// a keyed pseudonym rather than the address itself.
		const identity = account?.id ?? (await pseudonym(this.env, email));

		if (identity) {
			this.ctx.waitUntil(
				capture(
					this.env,
					"login_code_requested",
					{ delivered: sent.sent, existing_user: account !== undefined },
					{ userId: identity },
				),
			);
		}

		return json({ ok: true, sent: sent.sent, error: sent.error });
	}

	/** Exchange a code for a session, creating the user on first login. */
	private async verifyCode(request: Request): Promise<Response> {
		const input = await body(request, VerifyCodeSchema);

		if (input instanceof Response) return input;
		const email = normaliseEmail(input.email);
		const key = KEYS.loginCode + (await emailKey(email));
		const pending = await this.store.plain(key, LoginCodeSchema);

		if (!pending || pending.expiresAt < Date.now()) {
			await this.store.remove(key);

			return failure("That code has expired. Ask for a new one.");
		}

		if (pending.attempts >= MAX_ATTEMPTS) {
			await this.store.remove(key);

			return failure("Too many attempts. Ask for a new code.");
		}

		const hash = await codeHash(email, input.code.trim(), this.secret());

		// Constant-time: a length-aware comparison against the stored HMAC.
		if (!sameHash(hash, pending.hash)) {
			await this.store.putPlain(key, LoginCodeSchema, { ...pending, attempts: pending.attempts + 1 });

			return failure("That code is not right.");
		}

		await this.store.remove(key);

		const now = Date.now();
		const userKey = KEYS.user + (await emailKey(email));
		const existing = await this.store.plain(userKey, UserSchema);
		const user =
			existing ?? { id: newId("usr"), email, createdAt: now, updatedAt: now };

		if (!existing) {
			await this.store.putPlain(userKey, UserSchema, user);
			await this.store.putPlain(KEYS.userId + user.id, UserSchema, user);
		}

		const session = {
			id: newId("ses"),
			userId: user.id,
			createdAt: now,
			expiresAt: now + SESSION_TTL_MS,
			userAgent: request.headers.get("user-agent") ?? undefined,
		};

		await this.store.putPlain(KEYS.authSession + session.id, AuthSessionSchema, session);

		this.ctx.waitUntil(
			capture(
				this.env,
				"login_completed",
				{ new_user: existing === undefined },
				{ userId: user.id },
			),
		);

		return json({ ok: true, session: session.id, user });
	}

	/** Resolve a browser session to the user it belongs to. */
	private async session(request: Request): Promise<Response> {
		const input = await body(request, SessionRequestSchema);

		if (input instanceof Response) return input;
		const session = await this.store.plain(KEYS.authSession + input.id, AuthSessionSchema);

		if (!session || session.expiresAt < Date.now()) {
			if (session) await this.store.remove(KEYS.authSession + input.id);

			return json({ user: null });
		}

		const user = await this.store.plain(KEYS.userId + session.userId, UserSchema);

		return json({ user: user ?? null });
	}

	private async logout(request: Request): Promise<Response> {
		const input = await body(request, SessionRequestSchema);

		if (input instanceof Response) return input;
		await this.store.remove(KEYS.authSession + input.id);

		return json({ ok: true });
	}

	/** Create a server and add it to the owner's list. */
	private async createServer(request: Request): Promise<Response> {
		const input = await body(request, CreateServerSchema);

		if (input instanceof Response) return input;
		const now = Date.now();
		const server = {
			id: newId("srv"),
			name: cleanName(input.name) || "My agent",
			ownerId: input.userId,
			createdAt: now,
			updatedAt: now,
		};

		await this.store.putPlain(KEYS.serverRef + server.id, ServerRefSchema, server);
		await this.ctx.storage.put(KEYS.ownerIndex + input.userId + ":" + server.id, true);

		return json({ server });
	}

	private async listServers(request: Request): Promise<Response> {
		const input = await body(request, ListServersSchema);

		if (input instanceof Response) return input;
		const index = await this.ctx.storage.list<boolean>({ prefix: KEYS.ownerIndex + input.userId + ":" });
		const ids = [...index.keys()].map((key) => key.slice((KEYS.ownerIndex + input.userId + ":").length));
		const servers = await Promise.all(ids.map((id) => this.store.plain(KEYS.serverRef + id, ServerRefSchema)));

		return json({ servers: servers.filter((server) => server !== undefined) });
	}

	private async renameServer(request: Request): Promise<Response> {
		const input = await body(request, RenameServerSchema);

		if (input instanceof Response) return input;
		const owned = await this.ctx.storage.get<boolean>(KEYS.ownerIndex + input.userId + ":" + input.id);

		if (!owned) return failure("That server does not exist.", 404);
		const key = KEYS.serverRef + input.id;
		const server = await this.store.plain(key, ServerRefSchema);

		if (!server) return failure("That server does not exist.", 404);
		const next = { ...server, name: cleanName(input.name) || server.name, updatedAt: Date.now() };

		await this.store.putPlain(key, ServerRefSchema, next);

		return json({ server: next });
	}

	// --- Guild claims ---------------------------------------------------------

	/**
	 * Issue a code the user types in Discord.
	 *
	 * Binding a guild is an assertion of authority over it, and the web app has
	 * no Discord identity, so the claim has to be proven where Discord knows who
	 * you are: a slash command, checked for Manage Server.
	 */
	private async putClaim(request: Request): Promise<Response> {
		const input = await body(request, ClaimPutSchema);

		if (input instanceof Response) return input;
		const code = newId("clm", 4).replaceAll(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
		const claim = { serverId: input.serverId, guildId: input.guildId, createdAt: Date.now() };

		await this.store.putPlain(CLAIM + code, ClaimSchema, claim);

		return json({ code, expiresAt: claim.createdAt + CLAIM_TTL_MS });
	}

	private async getClaim(request: Request): Promise<Response> {
		const input = await body(request, ClaimLookupSchema);

		if (input instanceof Response) return input;
		const claim = await this.store.plain(CLAIM + input.code.trim().toUpperCase(), ClaimSchema);

		if (!claim) return failure("That code is not valid.", 404);
		if (Date.now() - claim.createdAt > CLAIM_TTL_MS) {
			await this.store.remove(CLAIM + input.code.trim().toUpperCase());

			return failure("That code has expired.", 410);
		}

		return json({ serverId: claim.serverId, guildId: claim.guildId });
	}

	private async dropClaim(request: Request): Promise<Response> {
		const input = await body(request, ClaimLookupSchema);

		if (input instanceof Response) return input;
		await this.store.remove(CLAIM + input.code.trim().toUpperCase());

		return json({ ok: true });
	}
}

/** The singleton instance every caller addresses. */
export const CONTROL_NAME = "control";

/** Whether a stored value is a server record, for the registry scan. */
export type { ServerIdSchema };
