import type { JSX } from "@solidjs/web";

import { BRAND, installUrl } from "../public";
import "./styles.css";

const REPOSITORY = "https://github.com/oscartbeaumont/eryn";

const FACTS = [
	"Agent always online",
	"Connect your own inference",
	"Integrate your other apps via MCP",
];

const FEATURES = [
	{
		title: "Threads, not tabs",
		body: "Each request gets a thread with a persistent session, so follow-ups carry the context instead of starting over. You can ask Eryn to subscribe to a channel if you want.",
	},
	{
		title: "Your models, your bill",
		body: "Connect your own inference provider and pick the model per server. Use any provider that OpenCode supports.",
	},
	{
		title: "Tools that do the work",
		body: "We give the agent a virtual filesystem and cutback shell for basic uses. Connect external services via MCP.",
	},
];

const COMMANDS = [
	{
		command: "/eryn setup",
		description: "Connect a provider, choose a model, and link MCP servers.",
		permission: "Manage Server",
	},
	{
		command: "@eryn what's the weather",
		description: "Mention Eryn with a request to start a thread. Reply in the thread to keep going.",
		permission: "Everyone",
	},
	{
		command: "/eryn stop",
		description: "Stop the run in the current thread. The session stays intact for the next message.",
		permission: "Everyone",
	},
	{
		command: "/eryn help",
		description: "Show the commands and point to where setup lives.",
		permission: "Everyone",
	},
];

function Container(props: { children: JSX.Element; class?: string }) {
	return (
		<div
			class={`mx-auto w-full max-w-[1440px] px-6 sm:px-10 lg:px-16 ${props.class ?? ""}`}
		>
			{props.children}
		</div>
	);
}

function Eyebrow(props: { children: JSX.Element }) {
	return (
		<p class="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">{props.children}</p>
	);
}

function Action(props: { href: string; primary?: boolean; children: JSX.Element }) {
	return (
		<a
			class={
				props.primary
					? "inline-flex items-center justify-center rounded-md border border-ink bg-ink px-[18px] py-[13px] text-sm font-semibold text-canvas transition-colors hover:border-[#d9d9de] hover:bg-[#d9d9de]"
					: "inline-flex items-center justify-center rounded-md border border-line bg-white/5 px-[18px] py-[13px] text-sm font-semibold text-ink transition-colors hover:border-[#3a3a42] hover:bg-white/[0.07]"
			}
			href={props.href}
			rel={props.href.startsWith("http") ? "noreferrer" : undefined}
		>
			{props.children}
		</a>
	);
}

export function Landing() {
	return (
		<div class="min-h-screen bg-canvas font-sans text-ink">
			<a
				class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-canvas"
				href="#main"
			>
				Skip to content
			</a>

			<header class="relative overflow-hidden">
				<img
					alt=""
					class="absolute inset-0 h-full w-full object-cover"
					height="564"
					src={BRAND.banner}
					width="1600"
				/>
				<div aria-hidden="true" class="cover-scrim absolute inset-0" />
				<div class="relative mx-auto flex min-h-[640px] w-full max-w-[1440px] flex-col px-6 pb-16 pt-6 sm:min-h-[720px] sm:px-10 lg:min-h-[840px] lg:px-16 lg:pb-24 lg:pt-7">
					<div class="mt-20 flex max-w-[780px] flex-col gap-6 lg:mt-[174px]">
						<Eyebrow>Your personal agent in Discord</Eyebrow>
						<h1 class="text-[clamp(4.5rem,15vw,9.75rem)] font-semibold leading-[0.86] tracking-[-0.055em] text-ink">
							eryn
						</h1>
						<p class="max-w-[620px] text-[17px] leading-[1.6] text-[#c9c9cf] sm:text-[18px]">
							Mention <strong class="font-semibold text-ink">@eryn</strong> in a server and it
							opens a thread, works the request through an agent, and streams the answer back.
							Reply in the thread and it keeps going.
						</p>
						<div class="flex flex-wrap items-center gap-3">
							<Action href={installUrl()} primary>
								Add to Discord
							</Action>
							<Action href={REPOSITORY}>GitHub</Action>
						</div>
					</div>
				</div>
			</header>

			<main id="main">
				<div class="border-b border-line">
					<Container class="py-[26px]">
						<ul class="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-faint">
							{FACTS.map((fact, index) => (
								<li class="flex items-center gap-4">
									{index > 0 ? (
										<span aria-hidden="true" class="text-[#3f3f46]">
											·
										</span>
									) : null}
									{fact}
								</li>
							))}
						</ul>
					</Container>
				</div>

				<section aria-label="What Eryn does" class="mt-24">
					<Container>
						<div class="grid gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-3">
							{FEATURES.map((feature) => (
								<article class="bg-panel px-6 py-[26px]">
									<h2 class="text-[16px] font-semibold tracking-[-0.01em] text-ink">
										{feature.title}
									</h2>
									<p class="mt-2.5 text-sm leading-[1.6] text-muted">{feature.body}</p>
								</article>
							))}
						</div>
					</Container>
				</section>

				<section class="mt-24" id="commands">
					<Container>
						<Eyebrow>Commands</Eyebrow>
						<h2 class="mt-4 text-[clamp(2rem,4vw,2.5rem)] font-semibold leading-[1.1] tracking-[-0.04em] text-ink">
							Start with a mention.
						</h2>

						<div class="mt-8 border-t border-line">
							{COMMANDS.map((entry) => (
								<div class="grid grid-cols-[1fr_auto] items-start gap-x-6 gap-y-3 border-b border-line py-[22px] md:grid-cols-[minmax(9rem,15rem)_1fr_auto]">
									<code class="col-start-1 row-start-1 justify-self-start whitespace-nowrap rounded border border-line bg-[#101014] px-2 py-0.5 font-mono text-[13px] text-ink">
										{entry.command}
									</code>
									<p class="col-span-2 row-start-2 text-sm leading-[1.55] text-muted md:col-span-1 md:col-start-2 md:row-start-1">
										{entry.description}
									</p>
									<span class="col-start-2 row-start-1 justify-self-end whitespace-nowrap pt-0.5 font-mono text-[10.5px] uppercase tracking-[0.11em] text-faint md:col-start-3">
										{entry.permission}
									</span>
								</div>
							))}
						</div>
					</Container>
				</section>

				<section class="mt-24">
					<Container>
						<div class="rounded-lg border border-line bg-panel px-6 py-14 text-center sm:px-16">
							<h2 class="text-[clamp(1.75rem,3.5vw,2.125rem)] font-semibold tracking-[-0.035em] text-ink">
								Connect Eryn to your server
							</h2>
							<p class="mx-auto mt-4 max-w-[560px] text-[16px] leading-[1.6] text-muted">
								Add Eryn, run <code class="font-mono text-[0.9em] text-ink">/eryn setup</code>,
								connect a provider, and choose a model. Then mention it anywhere.
							</p>
							<div class="mt-7 flex justify-center">
								<Action href={installUrl()} primary>
									Add to Discord
								</Action>
							</div>
						</div>
					</Container>
				</section>
			</main>

			<footer class="mt-24 border-t border-line">
				<Container class="flex flex-col gap-4 py-7 pb-12 text-[13px] sm:flex-row sm:items-center sm:justify-between">
					<p class="text-faint">
						Created by{" "}
						<a
							class="text-muted transition-colors hover:text-ink"
							href="https://otbeaumont.me"
							rel="noreferrer"
						>
							Oscar Beaumont
						</a>
					</p>
					<nav aria-label="Footer" class="flex flex-wrap gap-5 text-muted">
						<a class="transition-colors hover:text-ink" href="/terms">
							Terms
						</a>
						<a class="transition-colors hover:text-ink" href="/privacy">
							Privacy
						</a>
						<a class="transition-colors hover:text-ink" href="mailto:oscar@otbeaumont.me">
							Contact
						</a>
						<a class="transition-colors hover:text-ink" href={REPOSITORY} rel="noreferrer">
							GitHub
						</a>
					</nav>
				</Container>
			</footer>
		</div>
	);
}

export default Landing;
