/**
 * The landing page's PostHog wiring.
 *
 * PostHog is served through this Worker rather than directly from its own
 * host: the ingestion request then has the site's origin, so a blocker is less
 * likely to drop it. The proxy only ever reaches PostHog's two hosts.
 *
 * The page itself stays server-rendered. The snippet below is the whole client
 * bundle: it loads PostHog's `array.js` from the proxy and, once loaded,
 * records page views and explicit link clicks. Nothing is captured on a
 * deployment that is not the hosted one.
 */

import { POSTHOG_PROJECT_TOKEN, POSTHOG_PROXY_PATH } from "../public";

/** Whether this request belongs to the PostHog proxy. */
export function isPostHogRequest(pathname: string): boolean {
	return pathname === POSTHOG_PROXY_PATH || pathname.startsWith(`${POSTHOG_PROXY_PATH}/`);
}

/** Forward one PostHog request, choosing the asset host for static files. */
export async function posthogProxy(request: Request, url: URL): Promise<Response> {
	const rest = url.pathname.slice(POSTHOG_PROXY_PATH.length).replace(/^\//, "");
	// PostHog's loader and its configuration scripts live on the assets host;
	// ingestion and decision endpoints live on the ingestion host.
	const hostname = rest.startsWith("static/") ? "us-assets.i.posthog.com" : "us.i.posthog.com";
	const target = new URL(`https://${hostname}/${rest}`);
	target.search = url.search;

	const headers = new Headers(request.headers);
	headers.set("host", hostname);
	// Let the runtime negotiate compression rather than forwarding the
	// browser's encoding for a body it may re-encode.
	headers.set("accept-encoding", "");

	const response = await fetch(target.toString(), {
		method: request.method,
		headers,
		body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
	});
	// PostHog's loader and plugin files are versioned and immutable; the
	// ingestion host's responses are not.
	if (rest.startsWith("static/") && response.ok) {
		const cached = new Response(response.body, response);
		cached.headers.set("cache-control", "public, max-age=3600");
		return cached;
	}
	return response;
}

/**
 * The page's analytics script, including the PostHog loader.
 *
 * `location.hostname` is checked on the client because the landing page is
 * shared by forks: a self-hosted deployment should not report its visitors to
 * the hosted project. Local development is therefore silent too.
 */
export function analyticsScript(): string {
	return `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
if (location.hostname === "eryn.otbeaumont.me") {
  posthog.init("${POSTHOG_PROJECT_TOKEN}", {
    api_host: "${POSTHOG_PROXY_PATH}",
    ui_host: "https://us.posthog.com",
    defaults: "2025-05-24",
    person_profiles: "identified_only",
    persistence: "localStorage",
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    capture_exceptions: false
  });
}
document.addEventListener("click", function (event) {
  var link = event.target && event.target.closest ? event.target.closest("a[data-analytics]") : null;
  if (!link) return;
  var properties = {};
  if (link.dataset && link.dataset.location) properties.location = link.dataset.location;
  window.posthog.capture(link.dataset.analytics, properties);
});`;
}
