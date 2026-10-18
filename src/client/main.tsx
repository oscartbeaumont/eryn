import { render } from "@solidjs/web";
import App from "./App";
import "./theme.css";

// `/setup` was renamed to `/console`; keep old links working.
if (window.location.pathname === "/setup") {
	history.replaceState(null, "", `/console${window.location.search}`);
}

const root = document.getElementById("root");
if (!root) throw new Error("Eryn needs a #root element");

render(() => <App />, root);
