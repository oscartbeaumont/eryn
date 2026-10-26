import { For } from "solid-js";
import { installUrl } from "./discord";
import { A, buttonClass, Footer, Header, Kicker, SessionButton } from "./ui";

const features = [
	{
		num: "[01]",
		title: "Installed from Discord",
		body: "Add Eryn to a server and it walks an admin through setup with slash commands — connect a provider, pick a model. Inference runs on the server's own key, so nothing is billed to the operator.",
	},
	{
		num: "[02]",
		title: "Your accounts, connected once",
		body: "Connect Discord, GitHub and Google accounts in the console — as many as you like. Each one is sealed at rest and can be assigned to the MCP servers you host.",
	},
	{
		num: "[03]",
		title: "Your own MCP server",
		body: "Host MCP servers with GitHub, Google Calendar and Discord tools, hand each one a set of accounts, and point any harness at its endpoint over OAuth.",
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
							An OpenCode coding agent that lives in your Discord, and an MCP server you host yourself. Mention{" "}
							<strong class="font-semibold text-fg">@eryn</strong> in a server and it opens a thread for the request,
							works in a real workspace, and streams the answer back.
						</p>
						<p class="mb-8 max-w-[62ch] text-muted">
							The bot is set up entirely from Discord with{" "}
							<strong class="font-semibold text-fg">slash commands</strong> — no per-server configuration in the
							browser. Accounts and hosted MCP servers live in the console.
						</p>
						<div class="flex flex-wrap gap-3">
							<a href={installUrl()} target="_blank" rel="noreferrer" class={buttonClass.primary}>
								Add to Discord
							</a>
							<SessionButton />
							<A href="/console" class={buttonClass.ghost}>
								Open the console
							</A>
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
