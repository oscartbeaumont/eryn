/**
 * The console's signed-in session.
 *
 * It is a signed cookie rather than a row: `sign`/`verify` under `SESSION_SECRET`
 * carry the Discord id, the name, the avatar, and the user's Discord token. The
 * user id doubles as the name of their gateway Durable Object, which is the
 * security boundary — nothing else can be routed to their accounts.
 */

import { sign, verify } from "./crypto";
import { SESSION_TTL_MS, STATE_TTL_MS } from "./config";

export const SESSION_COOKIE = "eryn_session";
export const STATE_COOKIE = "eryn_state";

export interface Session {
	uid: string;
	name: string;
	/** The user's Discord OAuth token, kept so an account can be created from it. */
	token: string;
	avatarUrl?: string;
	exp: number;
}

export function cookieOptions(origin: string) {
	return { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax" as const, path: "/" };
}

export async function readSession(
	cookies: Record<string, string> | undefined,
	secret: string | undefined,
): Promise<Session | undefined> {
	if (!secret) return undefined;
	const session = await verify<Session>(cookies?.[SESSION_COOKIE], secret);
	if (!session || session.exp < Date.now() || typeof session.uid !== "string") return undefined;
	return session;
}

export function signSession(session: Session, secret: string): Promise<string> {
	return sign(session, secret);
}

/** A one-shot value carried in a signed cookie, for an OAuth round trip. */
export async function signState(payload: Record<string, unknown>, secret: string): Promise<string> {
	return sign({ ...payload, exp: Date.now() + STATE_TTL_MS }, secret);
}

export async function readState<T extends { exp: number }>(value: string | undefined, secret: string): Promise<T | undefined> {
	const state = await verify<T>(value, secret);
	if (!state || typeof state.exp !== "number" || state.exp < Date.now()) return undefined;
	return state;
}

export function sessionTtlMs(): number {
	return SESSION_TTL_MS;
}
