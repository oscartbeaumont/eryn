/**
 * PostHog, loaded once for the whole app.
 *
 * Nothing is captured in development. Two guards enforce that: `PROD` is false
 * under `pnpm dev`, and a production bundle served from a loopback host is
 * refused too, so a local `pnpm build && pnpm preview` never reports.
 *
 * When it is enabled, requests go to this origin's `/ingest` proxy rather than
 * to posthog.com, which keeps them first-party and out of ad blockers. The
 * project token comes from `/api/config`, so analytics can be switched off by
 * clearing a binding, with no rebuild.
 */

import posthog from "posthog-js";

let ready = false;
/** Crashes that happen before the SDK finishes loading, replayed once it has. */
const pending: unknown[] = [];
/** The signed-in account, if it arrived before the SDK did. */
let identity: { id: string; properties?: Record<string, unknown> } | undefined;

function isLocalHost(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

// PostHog installs its own handlers at init, so these only cover the window
// before that and stop contributing the moment it is ready.
window.addEventListener("error", (event) => {
	if (!ready) pending.push(event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
	if (!ready) pending.push(event.reason);
});

/** Start analytics. A `null` config (no token configured) leaves it disabled. */
export function initAnalytics(config: { key: string; uiHost: string } | null): void {
	if (ready || !config) return;
	if (!import.meta.env.PROD || isLocalHost(window.location.hostname)) return;
	ready = true;

	posthog.init(config.key, {
		api_host: window.location.origin,
		ui_host: config.uiHost,
		// Send every ingestion request to this origin's /ingest path, which the
		// Worker proxies onward. `rewriteRequestPath` is the documented contract
		// for exactly this, and it covers events, flags, and assets alike.
		rewriteRequestPath: (url) => {
			url.pathname = `/ingest${url.pathname}`;
			return url;
		},
		defaults: "2026-08-30",
		// The app is client-routed, so pageviews have to follow history changes.
		capture_pageview: "history_change",
		capture_pageleave: true,
		// Crash reporting: $exception events become Issues in PostHog.
		capture_exceptions: true,
		// Anonymous visitors stay anonymous; only signed-in accounts get profiles.
		person_profiles: "identified_only",
		disable_session_recording: true,
	});

	if (identity) posthog.identify(identity.id, identity.properties);

	// `capture_pageview: "history_change"` records later navigations but not the
	// load that started the session, so the landing page would never be counted.
	// The SDK's own initial capture is disabled at that setting, so this is the
	// only one and cannot double count.
	posthog.capture("$pageview");

	for (const error of pending.splice(0)) posthog.captureException(error);
}

/** Record a product event. A no-op before the SDK is ready. */
export function capture(event: string, properties?: Record<string, unknown>): void {
	if (!ready) return;
	posthog.capture(event, properties);
}

/** Tie subsequent events to the signed-in account. */
export function identify(id: string, properties?: Record<string, unknown>): void {
	identity = { id, properties };
	if (ready) posthog.identify(id, properties);
}
