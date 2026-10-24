/**
 * `@oscartbeaumont/eryn-bot` — the Discord bot.
 *
 * The bot has no public HTTP surface: `handle` always returns `undefined`, so
 * the root Worker moves on to the next package. What it does expose is the two
 * Durable Objects it is made of, and `wake`, which the Worker's health check
 * and cron use to poke the singleton gateway object.
 */

import { BotGateway } from "./gateway/do";
import { BotSession } from "./session/do";

export { BotGateway, BotSession };

/** The bot owns no public route; it is all Durable Objects and Discord events. */
export async function handle(_request: Request): Promise<Response | undefined> {
	return undefined;
}

/** Poke the singleton gateway object so it connects and arms its alarm. */
export async function wake(env: Env): Promise<void> {
	const stub = env.BOT_GATEWAY.get(env.BOT_GATEWAY.idFromName("bot"));
	await stub.fetch("https://bot.internal/wake");
}
