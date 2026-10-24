import { Match, Switch } from "solid-js";
import Accounts from "./Accounts";
import Authorize from "./Authorize";
import Landing from "./Landing";
import Servers from "./Servers";
import { createPath } from "./ui";

export default function App() {
	const raw = createPath();
	// A trailing slash is the same route; `/` stays the landing page.
	const path = () => raw().replace(/\/+$/, "") || "/";
	return (
		<div class="flex min-h-screen flex-col">
			<Switch fallback={<Landing />}>
				{/* The consent screen is checked first: it lives under /console/authorize. */}
				<Match when={path() === "/console/authorize"}>
					<Authorize />
				</Match>
				<Match when={path() === "/console/accounts"}>
					<Accounts />
				</Match>
				<Match when={path() === "/console"}>
					<Servers />
				</Match>
			</Switch>
		</div>
	);
}
