import { render } from "@solidjs/web";
import App from "./App";
import { initAnalytics } from "./analytics";
import { fetchConfig } from "./api";
import "./theme.css";

// `/setup` was renamed to `/console`; keep old links working.
if (window.location.pathname === "/setup") {
	history.replaceState(null, "", `/console${window.location.search}`);
}

const root = document.getElementById("root");
if (!root) throw new Error("Eryn needs a #root element");

// Analytics starts in parallel with the first render; it is a no-op in
// development, so this never costs a request there.
void fetchConfig()
	.then((config) => initAnalytics(config.posthog))
	.catch(() => undefined);

render(() => <App />, root);
