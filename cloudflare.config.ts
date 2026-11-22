import { bindings, defineConfig, exports, triggers } from "cf/config";
// oxlint-disable-next-line import/no-namespace -- Cloudflare requires a namespace import for the worker entrypoint.
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * The hosted deployment, and a fork of it.
 *
 * `cf deploy` from this repository publishes eryn.otbeaumont.me. A fork made by
 * the Deploy to Cloudflare button builds in Workers Builds, where that domain
 * belongs to someone else's account, so those deployments publish on
 * workers.dev instead. `ERYN_DOMAIN` attaches an explicit domain either way.
 */
const SELF_HOSTED = process.env.WORKERS_CI === "1";

const DOMAIN =
	process.env.ERYN_DOMAIN !== undefined
		? process.env.ERYN_DOMAIN.trim() || undefined
		: SELF_HOSTED
			? undefined
			: "eryn.otbeaumont.me";

/** The origin binding, present only when this deployment serves a domain. */
const publicOrigin = DOMAIN ? { PUBLIC_ORIGIN: bindings.text(`https://${DOMAIN}`) } : {};

/**
 * One Worker, four Durable Objects.
 *
 * The split is deliberate: `Control` owns identity and the server registry,
 * `Server` owns agent state (OpenCode, models, MCP links, files), `Hub` owns
 * the messaging data plane, and `Gateway` owns the one long-lived Discord
 * socket. No object calls back into itself through the Worker, which is what
 * lets the MCP transport stay a plain HTTP endpoint.
 */
export default defineConfig({
	worker: {
		name: "eryn",
		compatibilityDate: "2026-11-20",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		domains: DOMAIN ? [DOMAIN] : [],
		workersDev: DOMAIN === undefined,
		previewUrls: false,
		assets: {
			runWorkerFirst: ["/brand/*", "/favicon.ico"],
		},
		observability: {
			enabled: true,
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true, persist: true },
			traces: { enabled: true, persist: true },
			issues: { enabled: true },
		},
		triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
		env: {
			ASSETS: bindings.assets(),

			// Identity, logins, and the server registry.
			CONTROL: bindings.durableObject({ worker: "eryn", exportName: "Control" }),
			// One per Eryn server: settings, files, and the embedded OpenCode host.
			SERVER: bindings.durableObject({ worker: "eryn", exportName: "Server" }),
			// One per Eryn server: messaging bindings, event log, MCP tools.
			HUB: bindings.durableObject({ worker: "eryn", exportName: "Hub" }),
			// The singleton Discord gateway.
			GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "Gateway" }),

			// Runs custom agent plugins in isolated dynamic isolates.
			PLUGIN_LOADER: bindings.workerLoader(),

			// Shared, expiring files the agent sends to a messaging surface.
			// Configure an R2 lifecycle rule on this bucket to bound retention.
			ARTIFACTS: bindings.r2({ name: "eryn-artifacts" }),

			// Discord. One application for the whole deployment; each Eryn server
			// binds to one guild. Required to run the Discord provider; an
			// iMessage-only deployment can set a placeholder value.
			DISCORD_BOT_TOKEN: bindings.secret(),

			// Base64url 32-byte key protecting every stored credential at rest.
			ENCRYPTION_KEY: bindings.secret(),

			// Transactional email for login codes. Resend is the default adapter;
			// without a key a development deployment logs the code instead.
			EMAIL_FROM: bindings.text("Eryn <login@eryn.otbeaumont.me>"),

			...publicOrigin,

			CF_VERSION: bindings.versionMetadata(),
		},
		exports: {
			Control: exports.durableObject({ storage: "sqlite" }),
			Server: exports.durableObject({ storage: "sqlite" }),
			Hub: exports.durableObject({ storage: "sqlite" }),
			Gateway: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
