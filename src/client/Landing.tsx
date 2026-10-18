import { For } from "solid-js";
import { Footer, Header, Kicker, SessionButton } from "./ui";

const features = [
	{
		num: "[01]",
		title: "Bring your own key",
		body: "Sign in with Discord, pick a server you administer, and paste an OpenCode Go key. It is encrypted at rest and used only for that server.",
	},
	{
		num: "[02]",
		title: "A real workspace",
		body: "Every thread gets a virtual filesystem and a sandboxed shell, so the agent can create, edit, and run a project instead of only talking about it.",
	},
	{
		num: "[03]",
		title: "GitHub, end to end",
		body: "Read issues, clone a repository, make changes on a branch, and open a pull request — authenticated as a GitHub App.",
	},
];

export default function Landing() {
	return (
		<>
			<Header />
			<main class="flex-1">
				<section class="border-b border-line">
					<div class="mx-auto w-[min(1080px,92vw)] py-20">
						<Kicker>Your personal agent</Kicker>
						<h1 class="mb-5 text-[clamp(56px,13vw,128px)] font-bold leading-[0.9] tracking-[-0.045em]">eryn</h1>
						<p class="mb-5 max-w-[62ch] text-lg text-muted">
							An OpenCode coding agent that lives in your Discord. Mention{" "}
							<strong class="font-semibold text-fg">@eryn</strong> in a server and it opens a thread for the request,
							works in a real workspace, and streams the answer back.
						</p>
						<p class="mb-8 max-w-[62ch] text-muted">
							Every server runs on <strong class="font-semibold text-fg">its own OpenCode Go key</strong> — nothing is
							billed to the operator and no key is shared.
						</p>
						<div class="flex flex-wrap gap-3">
							<SessionButton />
						</div>
					</div>
				</section>

				<section class="border-b border-line">
					<div class="mx-auto w-[min(1080px,92vw)] py-20">
						<Kicker>A session, end to end</Kicker>
						<div class="border border-line bg-surface font-mono">
							<div class="flex justify-between border-b border-line px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-faint">
								<span>discord / #engineering</span>
								<span>thread</span>
							</div>
							<div class="grid gap-3 px-4 py-5 text-sm">
								<p>
									<span class="inline-block min-w-[46px] text-faint">you</span>
									@eryn fix the failing parser tests
								</p>
								<p>
									<span class="inline-block min-w-[46px] text-faint">eryn</span>
									<span class="text-faint">⠹ Thinking…</span>
								</p>
								<p>
									<span class="inline-block min-w-[46px] text-faint">eryn</span>
									cloned the repo, patched the parser, tests green — PR opened
								</p>
							</div>
						</div>
					</div>
				</section>

				<section class="mx-auto w-[min(1080px,92vw)] py-16">
					<div class="grid grid-cols-1 divide-y divide-line border border-line md:grid-cols-3 md:divide-x md:divide-y-0">
						<For each={features}>
							{(feature) => (
								<div class="px-6 py-7">
									<span class="mb-4 block font-mono text-[11px] tracking-[0.14em] text-faint">{feature.num}</span>
									<h2 class="font-mono text-[15px] font-semibold">{feature.title}</h2>
									<p class="mt-2 text-sm text-muted">{feature.body}</p>
								</div>
							)}
						</For>
					</div>
				</section>
			</main>
			<Footer />
		</>
	);
}
