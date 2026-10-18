import { Show } from "solid-js";
import Console from "./Console";
import Landing from "./Landing";
import { createPath } from "./ui";

export default function App() {
	const path = createPath();
	return (
		<div class="flex min-h-screen flex-col">
			<Show when={path().startsWith("/console")} fallback={<Landing />}>
				<Console />
			</Show>
		</div>
	);
}
