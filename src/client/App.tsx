import { Match, Switch } from "solid-js";
import Authorize from "./Authorize";
import Console from "./Console";
import ConsoleMcp from "./ConsoleMcp";
import Landing from "./Landing";
import { createPath } from "./ui";

export default function App() {
	const path = createPath();
	return (
		<div class="flex min-h-screen flex-col">
			<Switch fallback={<Landing />}>
				{/* The consent screen is checked first: it lives under /console/mcp. */}
				<Match when={path() === "/console/mcp/authorize"}>
					<Authorize />
				</Match>
				<Match when={path() === "/console/mcp"}>
					<ConsoleMcp />
				</Match>
				<Match when={path().startsWith("/console")}>
					<Console />
				</Match>
			</Switch>
		</div>
	);
}
