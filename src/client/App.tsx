import { Show } from "solid-js";
import Landing from "./Landing";
import Setup from "./Setup";
import { createPath } from "./ui";

export default function App() {
	const path = createPath();
	return (
		<div class="flex min-h-screen flex-col">
			<Show when={path().startsWith("/setup")} fallback={<Landing />}>
				<Setup />
			</Show>
		</div>
	);
}
