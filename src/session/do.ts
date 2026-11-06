/**
 * The guild session object.
 *
 * **One object per Discord guild.** The guild id is the object name, so a
 * guild's OpenCode database, virtual filesystem, provider credentials, and
 * linked MCP tokens all live in storage that no other guild can be routed to.
 *
 * It is a thin shell: it owns the guild's store and agent, serves the internal
 * routes the bot calls, and runs the alarm that restarts this object after a
 * deploy and wakes the host's schedule runner. It holds no Discord socket and
 * no timer of its own.
 */

import { DurableObject } from "cloudflare:workers";

import { log } from "../config";
import { deployChanged } from "../deploy";
import { discordRest, type DiscordRest } from "../discord/api";
import { describeError } from "../errors";
import { refreshLinks } from "../mcp/links";
import { createGuildAgent, type GuildAgentShape } from "./agent";
import type { HostConfig } from "./host-config";
import { buildRoutes, json } from "./routes";
import { guildStore, type GuildStoreShape } from "./store";

export class BotSessionV5 extends DurableObject<Env> {
	private readonly guildId: string;
	private readonly rest: DiscordRest;
	private readonly store: GuildStoreShape;
	private readonly agent: GuildAgentShape;
	private readonly router: (request: Request) => Promise<Response>;
	/** Requests currently running, so a deploy restart does not cut a turn in half. */
	private inFlight = 0;
	/** Whether this instance has seen a newer deploy; see `alarm`. */
	private restartPending = false;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.guildId = state.id.name ?? "";
		this.rest = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
		this.store = guildStore(state.storage, env.ENCRYPTION_KEY);
		this.agent = createGuildAgent(env, state.storage, this.rest, this.guildId);
		this.router = buildRoutes({
			env,
			guildId: this.guildId,
			rest: this.rest,
			store: this.store,
			agent: this.agent,
			loadConfig: (refresh) => this.loadConfig(refresh),
			reconcileModel: (config) => this.reconcileModel(config),
			armScheduleAlarm: () => this.armScheduleAlarm(),
		});
		log("session", `guild ${this.guildId} object created`);
	}

	async fetch(request: Request): Promise<Response> {
		// Count the request before the restart check: a request that arrives while
		// a restart is already armed must not be aborted in the moment before it
		// is counted, or the work it carries is lost with no error.
		this.inFlight += 1;
		try {
			await this.ensureCurrentVersion(request);
			return await this.router(request);
		} catch (error) {
			log("session", `internal route failed: ${describeError(error)}`);
			return json({ error: describeError(error) }, 500);
		} finally {
			this.inFlight -= 1;
		}
	}

	/**
	 * Restart this object when a deploy has moved on, once the current request is
	 * done. A live object keeps the code it started with, so a fix is invisible
	 * until it restarts; the caller tells it which deploy is current.
	 */
	private async ensureCurrentVersion(request: Request): Promise<void> {
		if (!(await deployChanged(this.ctx.storage, request, this.env))) return;
		this.restartPending = true;
		await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	async alarm(): Promise<void> {
		// The signal is in memory: an abort discards storage writes, so a
		// persisted marker would survive the restart and loop.
		if (this.restartPending) {
			if (this.inFlight > 0 || this.scheduleBusy()) {
				// A turn is still running. Restarting now would drop the reply, so wait
				// for it to finish and check again.
				await this.ctx.storage.setAlarm(Date.now() + 5_000);
				return;
			}
			// Retry the alarm: the replacement object starts with no timers, and a
			// schedule that was armed before the deploy must still be woken. The
			// stored deploy version is already current, so this cannot loop.
			this.ctx.abort("deploy changed", { retryAlarm: true });
			return;
		}
		// A schedule may have fallen due while this object was evicted. Building
		// the host starts its runner, which fires everything overdue; the alarm is
		// then re-armed for the next one.
		const due = this.scheduleDueAt();
		if (due !== null && due <= Date.now() + 1_000) {
			await this.runScheduleTick().catch((error) => log("session", `schedule tick failed: ${describeError(error)}`));
		}
		await this.armScheduleAlarm();
	}

	/** When the next active schedule is due, from the host's own SQLite. */
	private scheduleDueAt(): number | null {
		try {
			const row = this.ctx.storage.sql
				.exec("SELECT MIN(next_due_at) AS due FROM schedule WHERE status = 'active' AND next_due_at IS NOT NULL")
				.one() as { due: number | null };
			return typeof row.due === "number" ? row.due : null;
		} catch {
			// The table only exists once a session has had schedules enabled.
			return null;
		}
	}

	/** Wake the host so its schedule runner fires what is due. */
	private async runScheduleTick(): Promise<void> {
		// A fired schedule turns into a normal Session turn, which runs after this
		// request returns. Keep a follow-up alarm in case the object is evicted
		// before that turn settles; the next boot resumes a suspended Session.
		await this.ctx.storage.setAlarm(Date.now() + 30_000);
		const config = await this.loadConfig(true);
		if (config.connections.length === 0) return;
		await this.agent.ensureHost(config);
		// Give the admitted turn time to start before deciding when to wake next.
		await new Promise((resolve) => setTimeout(resolve, 8_000));
	}

	/** Whether a Session is mid-turn or suspended, so this object should wake again. */
	private scheduleBusy(): boolean {
		try {
			const row = this.ctx.storage.sql
				.exec(
					`SELECT COUNT(*) AS busy FROM session_v2
					 WHERE time_suspended IS NOT NULL
					    OR (time_busy IS NOT NULL AND (time_idle IS NULL OR time_busy > time_idle))`,
				)
				.one() as { busy: number };
			return Number(row.busy) > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Wake this object when the next schedule falls due.
	 *
	 * The runner only ticks while the object is in memory, and a Durable Object
	 * can be evicted between turns, so the due time is an alarm rather than a
	 * timer. A schedule that is already due wakes it shortly.
	 */
	private async armScheduleAlarm(): Promise<void> {
		if (this.restartPending) return;
		const due = this.scheduleDueAt();
		if (due !== null) {
			await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 5_000));
			return;
		}
		if (this.scheduleBusy()) {
			await this.ctx.storage.setAlarm(Date.now() + 20_000);
			return;
		}
		await this.ctx.storage.deleteAlarm().catch(() => undefined);
	}

	/** Everything the host needs, read once from this guild's own storage. */
	private async loadConfig(refresh = false): Promise<HostConfig> {
		const settings = await this.store.settings();
		const connections = await this.store.providers();
		const stored = await this.store.links();
		const links = refresh ? await refreshLinks(this.store, stored) : stored;
		return { connections, model: settings.model, links };
	}

	/**
	 * Point the guild at a model it can actually run.
	 *
	 * Connecting a provider does not change the stored model, and the default
	 * names `opencode-go` even when a guild connects `opencode`. Without this
	 * the first turn runs a model whose provider has no credential and
	 * produces nothing.
	 */
	private async reconcileModel(config: HostConfig): Promise<HostConfig> {
		try {
			const model = await this.agent.resolveModel(config);
			if (model === config.model) return config;
			const settings = await this.store.settings();
			await this.store.putSettings({ ...settings, model, updatedAt: Date.now() });
			log("session", `using ${model} instead of the unavailable ${config.model}`);
			return { ...config, model };
		} catch (error) {
			log("session", `could not reconcile the model: ${describeError(error)}`);
			return config;
		}
	}
}
