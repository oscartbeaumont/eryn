/** Tiny path router for the two public routes, plus shared presentational pieces. */

import { createSignal, onCleanup, Show } from "solid-js";
import type { Account } from "./api";
import { session } from "./session";

export const SOURCE_URL = "https://github.com/oscartbeaumont/eryn";
export const SITE_URL = "https://otbeaumont.me";

export function createPath() {
	const [path, setPath] = createSignal(window.location.pathname);
	const update = () => setPath(window.location.pathname);
	window.addEventListener("popstate", update);
	onCleanup(() => window.removeEventListener("popstate", update));
	return path;
}

export function navigate(to: string): void {
	history.pushState(null, "", to);
	window.dispatchEvent(new PopStateEvent("popstate"));
}

export function A(props: { href: string; class?: string; external?: boolean; children: any }) {
	return (
		<a
			href={props.href}
			class={props.class}
			target={props.external ? "_blank" : undefined}
			rel={props.external ? "noreferrer" : undefined}
			onClick={(event) => {
				if (props.external || event.defaultPrevented || event.button !== 0) return;
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				event.preventDefault();
				navigate(props.href);
			}}
		>
			{props.children}
		</a>
	);
}

const button =
	"inline-flex items-center justify-center gap-2 border px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors cursor-pointer";

export const buttonClass = {
	primary: `${button} border-transparent bg-invert text-invert-fg hover:bg-white`,
	ghost: `${button} border-line-strong text-fg hover:border-fg`,
	danger: `${button} border-danger/55 text-danger hover:border-danger hover:bg-danger/10`,
	small: `${button} px-3.5 py-2.5 border-line-strong text-fg hover:border-fg`,
};

/**
 * The primary hero action: "Sign in" when signed out, "Open console" when
 * signed in. It renders a neutral, equally-sized placeholder until the shared
 * session resolves, so the label never flips on load.
 */
export function SessionButton() {
	return (
		<Show
			when={session()}
			fallback={
				<span class={`${buttonClass.primary} min-w-[15rem] cursor-default opacity-50`} aria-busy="true">
					Loading…
				</span>
			}
		>
			{(state) =>
				state().signedIn ? (
					<A href="/console" class={`${buttonClass.primary} min-w-[15rem]`}>
						Open console
					</A>
				) : (
					<A href="/auth/discord" external class={`${buttonClass.primary} min-w-[15rem]`}>
						Sign in with Discord
					</A>
				)
			}
		</Show>
	);
}

const navLink = "font-mono text-[11px] uppercase tracking-[0.14em] transition-colors";

export function Header(props: { account?: Account }) {
	const path = createPath();
	return (
		<header class="border-b border-line">
			<div class="mx-auto flex h-16 w-[min(1080px,92vw)] items-center justify-between">
				<div class="flex items-center gap-7">
					<A href="/" class="inline-flex items-center gap-2.5 font-mono text-xl font-bold tracking-tight text-fg">
						<span class="inline-block size-3 bg-invert" />
						eryn
					</A>
					<Show when={props.account}>
						<nav class="flex items-center gap-5">
							<A
								href="/console"
								class={`${navLink} ${path() === "/console" ? "text-fg" : "text-muted hover:text-fg"}`}
							>
								Bot
							</A>
							<A
								href="/console/mcp"
								class={`${navLink} ${path().startsWith("/console/mcp") ? "text-fg" : "text-muted hover:text-fg"}`}
							>
								MCP
							</A>
						</nav>
					</Show>
				</div>
				<Show when={props.account}>
					{(account) => (
						<nav class="flex items-center gap-5">
							<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{account().name}</span>
							<A href="/auth/logout" external class={`${navLink} text-muted hover:text-fg`}>
								Sign out
							</A>
						</nav>
					)}
				</Show>
			</div>
		</header>
	);
}

export function Footer() {
	return (
		<footer class="border-t border-line">
			<div class="mx-auto flex w-[min(1080px,92vw)] flex-wrap justify-between gap-2 py-7 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
				<span>
					Created by{" "}
					<a
						href={SITE_URL}
						target="_blank"
						rel="noreferrer"
						class="border-b border-line-strong pb-0.5 font-semibold text-fg transition-colors hover:border-fg"
					>
						Oscar Beaumont <span class="text-faint">↗</span>
					</a>
				</span>
				<span class="flex gap-4">
					<a href={SOURCE_URL} target="_blank" rel="noreferrer" class="hover:text-fg">
						Source
					</a>
				</span>
			</div>
		</footer>
	);
}

/**
 * A small status pill. `tone` overrides the on/off default so a state that needs
 * attention, such as a server Eryn cannot run in, reads as a problem rather
 * than just as "not enabled".
 */
export function Chip(props: { on?: boolean; tone?: "ok" | "muted" | "danger"; children: any }) {
	const tone =
		props.tone === "danger"
			? "border-danger/55 text-danger"
			: props.tone === "ok" || (props.tone === undefined && props.on)
				? "border-transparent bg-ok text-invert-fg"
				: "border-line-strong text-muted";
	return (
		<span class={`ml-auto whitespace-nowrap border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${tone}`}>
			{props.children}
		</span>
	);
}

export function Notice(props: { kind: "ok" | "error"; children: any }) {
	const tone =
		props.kind === "ok" ? "border-ok/55 text-ok" : "border-danger/55 text-danger";
	return <div class={`mb-7 border px-4 py-3.5 text-sm ${tone}`}>{props.children}</div>;
}

export function Kicker(props: { children: any }) {
	return <p class="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">{props.children}</p>;
}

/** A copy-to-clipboard button that confirms itself briefly. */
export function CopyButton(props: { value: string; label?: string }) {
	const [copied, setCopied] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => timer && clearTimeout(timer));
	return (
		<button
			type="button"
			class={`${buttonClass.ghost} px-3.5 py-2.5`}
			onClick={() => {
				void navigator.clipboard
					.writeText(props.value)
					.then(() => {
						setCopied(true);
						timer = setTimeout(() => setCopied(false), 1_600);
					})
					.catch(() => setCopied(false));
			}}
		>
			{copied() ? "Copied" : (props.label ?? "Copy")}
		</button>
	);
}

/** A monospace block with the copy control docked in its header. */
export function Code(props: { title?: string; value: string }) {
	return (
		<div class="border border-line bg-surface">
			<div class="flex items-center justify-between border-b border-line px-4 py-2.5">
				<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{props.title ?? "Copy"}</span>
				<CopyButton value={props.value} />
			</div>
			<pre class="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-relaxed text-muted">{props.value}</pre>
		</div>
	);
}

export function Field(props: { label: string; hint?: string; children: any }) {
	return (
		<div class="mb-3.5">
			<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">{props.label}</span>
			{props.children}
			<Show when={props.hint}>
				<span class="mt-2 block text-xs text-faint">{props.hint}</span>
			</Show>
		</div>
	);
}

/** An eye, crossed out when the value is currently hidden. */
function EyeIcon(props: { hidden?: boolean }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="size-4"
			aria-hidden="true"
		>
			<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
			<circle cx="12" cy="12" r="2.6" />
			<Show when={props.hidden}>
				<path d="M4 4l16 16" />
			</Show>
		</svg>
	);
}

/**
 * A secret field with a reveal toggle.
 *
 * Worth having anywhere a credential is pasted: a mistyped character in a key
 * is invisible until a request fails much later, and the failure gives no hint
 * that the key itself was the problem.
 */
export function SecretInput(props: { name: string; placeholder?: string; autocomplete?: string }) {
	const [visible, setVisible] = createSignal(false);
	const label = () => (visible() ? "Hide the key" : "Show the key");
	return (
		<div class="relative">
			<input
				type={visible() ? "text" : "password"}
				name={props.name}
				placeholder={props.placeholder}
				autocomplete={props.autocomplete ?? "off"}
				spellcheck={false}
				class="w-full border border-line-strong bg-bg py-3 pl-3 pr-12 font-mono text-sm text-fg outline-none focus:border-fg"
			/>
			<button
				type="button"
				aria-label={label()}
				aria-pressed={visible() ? "true" : "false"}
				title={label()}
				class="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center text-faint transition-colors hover:text-fg"
				onClick={() => setVisible(!visible())}
			>
				<EyeIcon hidden={!visible()} />
			</button>
		</div>
	);
}
