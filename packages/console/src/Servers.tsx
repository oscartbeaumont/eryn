import { createSignal, For, Show } from "solid-js";
import { capture } from "./analytics";
import {
	fetchAccounts,
	fetchServers,
	fetchTools,
	serversAction,
	type AccountSummary,
	type ServerSummary,
	type ServersAction,
	type ServersData,
	type ToolAccess,
	type ToolAccessLevel,
	type ToolEntry,
	type ToolGroup,
	type ToolOverride,
	type UpstreamConnection,
} from "./api";
import { session } from "./session";
import { A, buttonClass, Chip, Code, CopyButton, Footer, Header, Kicker, Notice } from "./ui";

interface NoticeState {
	kind: "ok" | "error";
	message: string;
}

const LEVELS: readonly ToolAccessLevel[] = ["none", "read", "write", "all"];
const LEVEL_LABELS: Record<ToolAccessLevel, string> = {
	none: "None",
	read: "Read",
	write: "Write",
	all: "Read + write",
};

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toLevel(value: string): ToolAccessLevel {
	return LEVELS.find((level) => level === value) ?? "none";
}

/** A copy of a server's tool access, so an edit is not applied until saved. */
function cloneAccess(access: ToolAccess): ToolAccess {
	return {
		groups: { ...access.groups },
		tools: access.tools
			? {
					include: access.tools.include ? [...access.tools.include] : undefined,
					exclude: access.tools.exclude ? [...access.tools.exclude] : undefined,
					access: access.tools.access ? { ...access.tools.access } : undefined,
				}
			: undefined,
	};
}

/** A notice carried in on a redirect, such as an upstream sign-in finishing. */
function redirectNotice(): NoticeState | undefined {
	const params = new URLSearchParams(window.location.search);
	const error = params.get("error");
	if (error) return { kind: "error", message: error };
	const ok = params.get("ok");
	if (ok) return { kind: "ok", message: ok };
	return undefined;
}

export default function Servers() {
	const [data, setData] = createSignal<ServersData>();
	const [accounts, setAccounts] = createSignal<AccountSummary[]>([]);
	const [groups, setGroups] = createSignal<ToolGroup[]>([]);
	const [notice, setNotice] = createSignal<NoticeState | undefined>(redirectNotice());
	const [busy, setBusy] = createSignal(false);

	async function reload() {
		try {
			const [serversData, accountsData, toolsData] = await Promise.all([fetchServers(), fetchAccounts(), fetchTools()]);
			setData(serversData);
			setAccounts(accountsData.accounts);
			setGroups(toolsData.groups);
		} catch (error) {
			setNotice({ kind: "error", message: describe(error) });
		}
	}
	void reload();

	const flash = (kind: NoticeState["kind"], message: string) => setNotice({ kind, message });

	async function mutate(action: ServersAction, success: string) {
		setBusy(true);
		try {
			const result = await serversAction(action);
			capture(`server_${action.action}`);
			if (result.url) {
				// An OAuth action hands back where to sign in; leaving the page
				// lets the provider's own consent screen do the rest.
				window.location.href = result.url;
				return;
			}
			flash("ok", result.message ?? success);
			await reload();
		} catch (error) {
			flash("error", describe(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Header account={session()?.account} />
			<main class="flex-1">
				<section class="mx-auto w-[min(820px,92vw)] py-12">
					<Show when={notice()}>{(current) => <Notice kind={current().kind}>{current().message}</Notice>}</Show>

					<Show when={data()} fallback={<p class="font-mono text-sm text-faint">Loading…</p>}>
						{(loaded) => (
							<Show when={loaded().signedIn} fallback={<SignIn />}>
								<Kicker>MCP</Kicker>
								<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
									MCP servers
								</h1>
								<p class="mb-8 max-w-[62ch] text-muted">
									Each hosted server is its own MCP endpoint with its own tools, accounts, and Discord grants.
									Point a harness at its URL and it handles OAuth itself; grant one to a Discord server with{" "}
									<code class="font-mono">/eryn mcp link</code>.
								</p>

								<CreateServer
									busy={busy()}
									onCreate={(action) => void mutate(action, "Server created.")}
								/>

								<Show
									when={loaded().servers.length > 0}
									fallback={
										<p class="mt-8 border border-dashed border-line-strong px-4 py-3.5 text-sm text-muted">
											No servers yet. Create one above, then point a harness at its endpoint.
										</p>
									}
								>
									<div class="mt-8 flex flex-col gap-4">
										<For each={loaded().servers}>
											{(server) => (
												<ServerCard
													server={server}
													accounts={accounts()}
													groups={groups()}
													busy={busy()}
													onMutate={(action, success) => void mutate(action, success)}
													onNotice={flash}
												/>
											)}
										</For>
									</div>
								</Show>
							</Show>
						)}
					</Show>
				</section>
			</main>
			<Footer />
		</>
	);
}

function SignIn() {
	return (
		<>
			<Kicker>MCP</Kicker>
			<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">Host your own MCP</h1>
			<p class="mb-8 max-w-[62ch] text-muted">
				Sign in with Discord to host MCP servers, connect your accounts, and grant servers access to a Discord guild.
			</p>
			<a href="/auth/discord" class={buttonClass.primary}>
				Sign in with Discord
			</a>
		</>
	);
}

function CreateServer(props: { busy: boolean; onCreate: (action: ServersAction) => void }) {
	const [name, setName] = createSignal("");
	const [title, setTitle] = createSignal("");

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const slug = name().trim();
		if (!slug) return;
		props.onCreate({ action: "create", name: slug, title: title().trim() || undefined });
		setName("");
		setTitle("");
	}

	return (
		<form class="flex flex-wrap items-end gap-3" onSubmit={submit}>
			<label class="min-w-0 flex-1">
				<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Name</span>
				<input
					type="text"
					value={name()}
					placeholder="personal"
					spellcheck={false}
					class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
					onInput={(event) => setName(event.currentTarget.value)}
				/>
			</label>
			<label class="min-w-0 flex-1">
				<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
					Title (optional)
				</span>
				<input
					type="text"
					value={title()}
					placeholder="Personal"
					spellcheck={false}
					class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
					onInput={(event) => setTitle(event.currentTarget.value)}
				/>
			</label>
			<button type="submit" class={buttonClass.primary} disabled={props.busy}>
				Create
			</button>
		</form>
	);
}


/**
 * The tools one access brings, and what they may do.
 *
 * A group's level is the coarse control — read or write selects by each tool's
 * classification — and the per-tool rules refine it. Both live under the
 * account or upstream that provides them, because neither means anything
 * without it.
 */
function GroupAccess(props: {
	group: ToolGroup;
	access: ToolAccess;
	onGroup: (level: ToolAccessLevel) => void;
	onKind: (tool: string, kind: "" | "read" | "write") => void;
	onOverride: (tool: string, mode: "group" | "include" | "exclude") => void;
}) {
	const kindOf = (tool: ToolEntry) => props.access.tools?.access?.[tool.name] ?? tool.access;
	const overrideOf = (tool: string) =>
		props.access.tools?.include?.includes(tool)
			? "include"
			: props.access.tools?.exclude?.includes(tool)
				? "exclude"
				: "group";

	return (
		<div class="mt-3 border border-line bg-bg">
			<div class="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
				<span class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Access</span>
				<select
					value={props.access.groups[props.group.id] ?? "none"}
					onChange={(event) => props.onGroup(toLevel(event.currentTarget.value))}
					class="border border-line-strong bg-surface px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-fg"
				>
					<For each={LEVELS}>{(level) => <option value={level}>{LEVEL_LABELS[level]}</option>}</For>
				</select>
				<span class="ml-auto text-xs text-muted">
					{props.group.tools.length} tool{props.group.tools.length === 1 ? "" : "s"}
				</span>
			</div>
			<Show when={props.group.tools.length > 0}>
				<details class="px-3 py-2">
					<summary class="cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
						Per-tool rules ({props.group.tools.length})
					</summary>
					<div class="mt-2 divide-y divide-line border border-line">
						<For each={props.group.tools}>
							{(tool) => (
								<div class="flex flex-wrap items-center gap-2 px-3 py-2">
									<div class="min-w-0 flex-1">
										<div class="font-mono text-xs text-fg">{tool.name}</div>
										<div class="truncate text-xs text-muted">{tool.description || tool.title}</div>
									</div>
									<select
										value={kindOf(tool)}
										onChange={(event) => props.onKind(tool.name, event.currentTarget.value as "" | "read" | "write")}
										title="What this tool counts as"
										class="border border-line-strong bg-surface px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-fg"
									>
										<option value="">Default ({tool.access})</option>
										<option value="read">Read</option>
										<option value="write">Write</option>
									</select>
									<select
										value={overrideOf(tool.name)}
										onChange={(event) =>
											props.onOverride(
												tool.name,
												event.currentTarget.value === "include"
													? "include"
													: event.currentTarget.value === "exclude"
														? "exclude"
														: "group",
											)
										}
										title="Whether this tool follows its group"
										class="border border-line-strong bg-surface px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-fg"
									>
										<option value="group">Use group</option>
										<option value="include">Always include</option>
										<option value="exclude">Exclude</option>
									</select>
								</div>
							)}
						</For>
					</div>
				</details>
			</Show>
		</div>
	);
}

function ServerCard(props: {
	server: ServerSummary;
	accounts: AccountSummary[];
	groups: ToolGroup[];
	busy: boolean;
	onMutate: (action: ServersAction, success: string) => void;
	onNotice: (kind: NoticeState["kind"], message: string) => void;
}) {
	const [renaming, setRenaming] = createSignal(false);
	const [name, setName] = createSignal(props.server.name);
	const [title, setTitle] = createSignal(props.server.title ?? "");
	const [selected, setSelected] = createSignal<string[]>(props.server.accounts.map((account) => account.id));
	const [access, setAccess] = createSignal<ToolAccess>(cloneAccess(props.server.tools));
	const [connectionUrl, setConnectionUrl] = createSignal("");
	const [connectionTitle, setConnectionTitle] = createSignal("");
	const [connectionAuth, setConnectionAuth] = createSignal<"none" | "headers" | "oauth">("oauth");
	const [connectionHeaders, setConnectionHeaders] = createSignal<{ name: string; value: string }[]>([
		{ name: "Authorization", value: "" },
	]);
	const [clientId, setClientId] = createSignal("");
	const [clientSecret, setClientSecret] = createSignal("");
	const [addingUpstream, setAddingUpstream] = createSignal(false);

	/** One upstream connection as a tool group, with the names this server exposes. */
	function upstreamGroup(connection: UpstreamConnection): ToolGroup {
		return {
			id: connection.name,
			name: connection.title ?? connection.name,
			tools: connection.tools.map((tool) => ({
				name: tool.exposedName,
				title: tool.title ?? tool.name,
				description: tool.description ?? "",
				group: connection.name,
				access: tool.access,
			})),
		};
	}

	/** The built-in groups the assigned accounts bring. */
	const assignedGroups = (): ToolGroup[] => {
		const providers = new Set(
			props.accounts.filter((account) => selected().includes(account.id)).map((account) => account.provider),
		);
		return props.groups.filter((group) => group.provider !== undefined && providers.has(group.provider));
	};

	const allGroups = (): ToolGroup[] => [
		...assignedGroups(),
		...props.server.connections.filter((connection) => connection.enabled).map(upstreamGroup),
	];

	function toggleEnabled() {
		props.onMutate(
			{ action: "update", id: props.server.id, enabled: !props.server.enabled },
			props.server.enabled ? "Server disabled." : "Server enabled.",
		);
	}

	function saveName(event: SubmitEvent) {
		event.preventDefault();
		const slug = name().trim();
		if (!slug) return;
		props.onMutate(
			{ action: "update", id: props.server.id, name: slug, title: title().trim() || undefined },
			"Server updated.",
		);
		setRenaming(false);
	}

	function remove() {
		if (!confirm(`Delete "${props.server.name}"? Its endpoint stops working immediately.`)) return;
		props.onMutate({ action: "delete", id: props.server.id }, "Server deleted.");
	}

	function toggleAccount(id: string, on: boolean) {
		setSelected((current) => (on ? [...current, id] : current.filter((entry) => entry !== id)));
	}

	function setGroup(groupId: string, level: ToolAccessLevel) {
		setAccess((current) => ({ ...current, groups: { ...current.groups, [groupId]: level } }));
	}

	function setOverride(tool: string, mode: "group" | "include" | "exclude") {
		setAccess((current) => {
			const include = new Set(current.tools?.include ?? []);
			const exclude = new Set(current.tools?.exclude ?? []);
			include.delete(tool);
			exclude.delete(tool);
			if (mode === "include") include.add(tool);
			if (mode === "exclude") exclude.add(tool);
			const tools: ToolOverride = {
				...(current.tools?.access && Object.keys(current.tools.access).length
					? { access: { ...current.tools.access } }
					: {}),
			};
			if (include.size) tools.include = [...include];
			if (exclude.size) tools.exclude = [...exclude];
			return { groups: { ...current.groups }, tools };
		});
	}

	/** What a tool counts as when its group is read or write. */
	function toolKind(tool: ToolEntry): "read" | "write" {
		return access().tools?.access?.[tool.name] ?? tool.access;
	}

	function setToolKind(tool: string, kind: "" | "read" | "write") {
		setAccess((current) => {
			const overrides = { ...(current.tools?.access ?? {}) };
			if (kind) overrides[tool] = kind;
			else delete overrides[tool];
			const tools: ToolOverride = {
				...(current.tools?.include ? { include: [...current.tools.include] } : {}),
				...(current.tools?.exclude ? { exclude: [...current.tools.exclude] } : {}),
				...(Object.keys(overrides).length ? { access: overrides } : {}),
			};
			return { groups: { ...current.groups }, tools };
		});
	}

	function overrideMode(tool: string): "group" | "include" | "exclude" {
		const current = access();
		if (current.tools?.include?.includes(tool)) return "include";
		if (current.tools?.exclude?.includes(tool)) return "exclude";
		return "group";
	}

	function setEveryGroup(level: ToolAccessLevel) {
		setAccess((current) => {
			const groups = { ...current.groups };
			for (const group of allGroups()) groups[group.id] = level;
			return { groups, tools: current.tools };
		});
	}

	function addConnection(event: SubmitEvent) {
		event.preventDefault();
		const url = connectionUrl().trim();
		if (!url) return;
		const headers: Record<string, string> = {};
		for (const row of connectionHeaders()) {
			if (row.name.trim() && row.value.trim()) headers[row.name.trim()] = row.value.trim();
		}
		props.onMutate(
			{
				action: "connection-add",
				id: props.server.id,
				url,
				title: connectionTitle().trim() || undefined,
				auth: connectionAuth(),
				...(connectionAuth() === "headers" ? { headers } : {}),
				...(connectionAuth() === "oauth" && clientId().trim() ? { clientId: clientId().trim() } : {}),
				...(connectionAuth() === "oauth" && clientSecret().trim() ? { clientSecret: clientSecret().trim() } : {}),
				...stagedAccess(),
			},
			"Upstream server added.",
		);
		setConnectionUrl("");
		setConnectionTitle("");
		setAddingUpstream(false);
	}

	function refreshConnection(connection: UpstreamConnection) {
		props.onMutate(
			{ action: "connection-refresh", id: props.server.id, connectionId: connection.id, ...stagedAccess() },
			"Upstream tools refreshed.",
		);
	}

	function signIn(connection: UpstreamConnection) {
		props.onMutate(
			{ action: "connection-signin", id: props.server.id, connectionId: connection.id, ...stagedAccess() },
			"Signed in.",
		);
	}

	function toggleConnection(connection: UpstreamConnection) {
		props.onMutate(
			{
				action: "connection-update",
				id: props.server.id,
				connectionId: connection.id,
				enabled: !connection.enabled,
				...stagedAccess(),
			},
			connection.enabled ? "Upstream disabled." : "Upstream enabled.",
		);
	}

	function removeConnection(connection: UpstreamConnection) {
		if (!confirm(`Remove the ${connection.name} upstream? Its tools stop being exposed.`)) return;
		props.onMutate(
			{ action: "connection-remove", id: props.server.id, connectionId: connection.id, ...stagedAccess() },
			"Upstream removed.",
		);
	}

	function setHeader(index: number, field: "name" | "value", value: string) {
		setConnectionHeaders((current) =>
			current.map((row, position) => (position === index ? { ...row, [field]: value } : row)),
		);
	}

	/** The access as staged, so a connection action writes it instead of reverting it. */
	const stagedAccess = () => ({ accountIds: selected(), tools: access() });

	function saveAccess() {
		props.onMutate(
			{ action: "access", id: props.server.id, accountIds: selected(), tools: access() },
			"Access saved.",
		);
	}

	function revokeGrant(guildId: string) {
		if (!confirm(`Revoke access for guild ${guildId}?`)) return;
		props.onMutate({ action: "revoke-grant", id: props.server.id, guildId }, "Access revoked.");
	}

	const harnessConfig = () =>
		`{\n  "mcp": {\n    "servers": {\n      "${props.server.name}": {\n        "type": "remote",\n        "url": "${props.server.endpoint}"\n      }\n    }\n  }\n}`;

	return (
		<div class="border border-line bg-surface p-6">
			<div class="mb-4 flex flex-wrap items-center gap-3">
				<Show
					when={renaming()}
					fallback={
						<>
							<span class="font-mono text-base font-semibold">{props.server.name}</span>
							<Show when={props.server.title}>
								{(current) => <span class="text-sm text-muted">{current()}</span>}
							</Show>
							<Chip tone={props.server.enabled ? "ok" : "danger"}>{props.server.enabled ? "On" : "Off"}</Chip>
							<div class="ml-auto flex flex-wrap gap-2">
								<button
									type="button"
									class={buttonClass.ghost}
									disabled={props.busy}
									onClick={() => {
										setName(props.server.name);
										setTitle(props.server.title ?? "");
										setRenaming(true);
									}}
								>
									Rename
								</button>
								<button type="button" class={buttonClass.ghost} disabled={props.busy} onClick={toggleEnabled}>
									{props.server.enabled ? "Disable" : "Enable"}
								</button>
								<button type="button" class={buttonClass.danger} disabled={props.busy} onClick={remove}>
									Delete
								</button>
							</div>
						</>
					}
				>
					<form class="flex w-full flex-wrap items-end gap-3" onSubmit={saveName}>
						<label class="min-w-0 flex-1">
							<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Name</span>
							<input
								type="text"
								value={name()}
								spellcheck={false}
								class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
								onInput={(event) => setName(event.currentTarget.value)}
							/>
						</label>
						<label class="min-w-0 flex-1">
							<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
								Title
							</span>
							<input
								type="text"
								value={title()}
								spellcheck={false}
								class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
								onInput={(event) => setTitle(event.currentTarget.value)}
							/>
						</label>
						<button type="submit" class={buttonClass.primary} disabled={props.busy}>
							Save
						</button>
						<button type="button" class={buttonClass.ghost} onClick={() => setRenaming(false)}>
							Cancel
						</button>
					</form>
				</Show>
			</div>

			{/* Endpoint and the self-test. */}
			<div class="mb-5">
				<div class="mb-2 flex items-center gap-3">
					<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Endpoint</span>
					<Chip tone="muted">OAuth 2.1</Chip>
				</div>
				<div class="flex flex-wrap items-center gap-3">
					<code class="min-w-0 flex-1 truncate border border-line-strong bg-bg px-3 py-3 font-mono text-sm">
						{props.server.endpoint}
					</code>
					<CopyButton value={props.server.endpoint} />
				</div>
			</div>

			{/* What the server can act with, each with the tools it brings. */}
			<div class="mb-5">
				<div class="mb-2 flex items-center gap-3">
					<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Access</span>
					<Show when={allGroups().length > 0}>
						<span class="ml-auto flex flex-wrap gap-2">
							<button type="button" class={buttonClass.small} onClick={() => setEveryGroup("read")}>
								All read
							</button>
							<button type="button" class={buttonClass.small} onClick={() => setEveryGroup("all")}>
								All read + write
							</button>
						</span>
					</Show>
				</div>
				<p class="mb-3 max-w-[62ch] text-sm text-muted">
					Tools come from whatever the server acts with. Assign an account to give it that provider's tools, or add
					an upstream MCP server, then choose what each group may do.
				</p>

				<Show
					when={props.accounts.length > 0}
					fallback={
						<p class="mb-3 text-sm text-muted">
							No accounts connected yet.{" "}
							<A href="/console/accounts" class="border-b border-line-strong text-fg">
								Connect one
							</A>{" "}
							to give this server something to act with.
						</p>
					}
				>
					<div class="divide-y divide-line border border-line-strong">
						<For each={props.accounts}>
							{(account) => {
								const group = () => props.groups.find((entry) => entry.provider === account.provider);
								const firstOfProvider = () =>
									props.accounts.filter(
										(entry) => entry.provider === account.provider && selected().includes(entry.id),
									)[0]?.id === account.id;
								return (
									<div class="px-4 py-3">
										<label class="flex cursor-pointer items-center gap-3">
											<input
												type="checkbox"
												class="size-4 border border-line-strong bg-bg"
												checked={selected().includes(account.id)}
												onChange={(event) => toggleAccount(account.id, event.currentTarget.checked)}
											/>
											<span class="min-w-0 flex-1 font-mono text-sm">
												{account.profile.name ?? account.profile.username}
												<span class="text-faint"> · {account.label}</span>
											</span>
											<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
												{account.provider}
											</span>
										</label>
										<Show when={selected().includes(account.id) ? group() : undefined}>
											{(current) => (
												<Show
													when={firstOfProvider()}
													fallback={
														<p class="mt-2 pl-7 text-xs text-muted">
															Shares the {current().name} tools above.
														</p>
													}
												>
													<GroupAccess
														group={current()}
														access={access()}
														onGroup={(level) => setGroup(current().id, level)}
														onKind={(tool, kind) => setToolKind(tool, kind)}
														onOverride={(tool, mode) => setOverride(tool, mode)}
													/>
												</Show>
											)}
										</Show>
									</div>
								);
							}}
						</For>
					</div>
				</Show>

				{/* Other MCP servers whose tools this one republishes. */}
				<div class="mt-4">
					<div class="mb-2 flex items-center gap-3">
						<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Upstream servers</span>
					</div>
					<p class="mb-3 max-w-[62ch] text-sm text-muted">
						Federate another MCP server's tools. Sign in with OAuth when it asks for one, or send your own
						headers; its tools appear here as their own group, prefixed with the connection's name.
					</p>
					<Show
						when={props.server.connections.length > 0}
						fallback={<p class="mb-3 text-sm text-muted">No upstream servers yet.</p>}
					>
						<div class="divide-y divide-line border border-line-strong">
							<For each={props.server.connections}>
								{(connection) => (
									<div class="px-4 py-3">
										<div class="flex flex-wrap items-center gap-3">
											<span class="min-w-0 flex-1 truncate font-mono text-sm">{connection.name}</span>
											<Show when={connection.title}>
												{(current) => <span class="text-xs text-muted">{current()}</span>}
											</Show>
											<Chip tone={connection.enabled ? "ok" : "danger"}>
												{connection.enabled ? "On" : "Off"}
											</Chip>
											<span class="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
												{connection.auth}
											</span>
										</div>
										<div class="mt-1 truncate font-mono text-xs text-muted">{connection.url}</div>
										<Show when={connection.headerNames.length > 0}>
											<div class="mt-1 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
												headers: {connection.headerNames.join(", ")}
											</div>
										</Show>
										<Show when={connection.auth === "oauth" && !connection.authenticated}>
											<p class="mt-1 text-xs text-muted">
												{connection.pending ? "Waiting for the sign-in to finish." : "Not signed in yet."}
											</p>
										</Show>
										<div class="mt-2 flex flex-wrap gap-2">
											<Show when={connection.auth === "oauth" && (!connection.authenticated || connection.pending)}>
												<button
													type="button"
													class={buttonClass.primary}
													disabled={props.busy}
													onClick={() => signIn(connection)}
												>
													{connection.pending ? "Restart sign-in" : "Sign in"}
												</button>
											</Show>
											<button
												type="button"
												class={buttonClass.small}
												disabled={props.busy || !connection.authenticated}
												onClick={() => refreshConnection(connection)}
											>
												Refresh tools
											</button>
											<button
												type="button"
												class={buttonClass.small}
												disabled={props.busy}
												onClick={() => toggleConnection(connection)}
											>
												{connection.enabled ? "Disable" : "Enable"}
											</button>
											<button
												type="button"
												class={buttonClass.danger}
												disabled={props.busy}
												onClick={() => removeConnection(connection)}
											>
												Remove
											</button>
										</div>
										<Show when={connection.enabled && connection.tools.length > 0}>
											<GroupAccess
												group={upstreamGroup(connection)}
												access={access()}
												onGroup={(level) => setGroup(connection.name, level)}
												onKind={(tool, kind) => setToolKind(tool, kind)}
												onOverride={(tool, mode) => setOverride(tool, mode)}
											/>
										</Show>
									</div>
								)}
							</For>
						</div>
					</Show>

					<Show when={addingUpstream()}>
					<form class="mt-3 flex flex-col gap-3 border border-line-strong p-4" onSubmit={addConnection}>
						<div class="flex flex-wrap items-end gap-3">
							<label class="min-w-0 flex-1">
								<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
									Server URL
								</span>
								<input
									type="url"
									value={connectionUrl()}
									placeholder="https://api.example.com/mcp"
									spellcheck={false}
									class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
									onInput={(event) => setConnectionUrl(event.currentTarget.value)}
								/>
							</label>
							<label class="min-w-0 flex-1">
								<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
									Name (optional)
								</span>
								<input
									type="text"
									value={connectionTitle()}
									placeholder="fastmail"
									spellcheck={false}
									class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
									onInput={(event) => setConnectionTitle(event.currentTarget.value)}
								/>
							</label>
							<label class="flex flex-col">
								<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
									Auth
								</span>
								<select
									value={connectionAuth()}
									onChange={(event) =>
										setConnectionAuth(event.currentTarget.value as "none" | "headers" | "oauth")
									}
									class="border border-line-strong bg-surface px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
								>
									<option value="oauth">OAuth sign-in</option>
									<option value="headers">Custom headers</option>
									<option value="none">No auth</option>
								</select>
							</label>
						</div>
						<Show when={connectionAuth() === "oauth"}>
							<div class="flex flex-wrap items-center gap-2">
								<input
									type="text"
									value={clientId()}
									placeholder="Client ID (optional)"
									spellcheck={false}
									class="min-w-0 flex-1 border border-line-strong bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
									onInput={(event) => setClientId(event.currentTarget.value)}
								/>
								<input
									type="password"
									value={clientSecret()}
									placeholder="Client secret (optional)"
									class="min-w-0 flex-1 border border-line-strong bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
									onInput={(event) => setClientSecret(event.currentTarget.value)}
								/>
							</div>
							<p class="text-xs text-muted">
								Leave both blank and Eryn registers itself, or presents a client metadata document when the
								server accepts one instead of registering.
							</p>
						</Show>
						<Show when={connectionAuth() === "headers"}>
							<div class="flex flex-col gap-2">
								<For each={connectionHeaders()}>
									{(row, index) => (
										<div class="flex flex-wrap items-center gap-2">
											<input
												type="text"
												value={row.name}
												placeholder="Authorization"
												spellcheck={false}
												class="w-40 border border-line-strong bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
												onInput={(event) => setHeader(index(), "name", event.currentTarget.value)}
											/>
											<input
												type="password"
												value={row.value}
												placeholder="Bearer …"
												class="min-w-0 flex-1 border border-line-strong bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
												onInput={(event) => setHeader(index(), "value", event.currentTarget.value)}
											/>
										</div>
									)}
								</For>
								<button
									type="button"
									class={buttonClass.small}
									onClick={() => setConnectionHeaders((current) => [...current, { name: "", value: "" }])}
								>
									Add header
								</button>
							</div>
						</Show>
						<div class="flex items-center gap-3">
							<button type="submit" class={buttonClass.primary} disabled={props.busy}>
								{connectionAuth() === "oauth" ? "Add and sign in" : "Add upstream"}
							</button>
							<button type="button" class={buttonClass.ghost} onClick={() => setAddingUpstream(false)}>
								Cancel
							</button>
							<span class="text-xs text-muted">Headers are stored encrypted and never shown again.</span>
						</div>
					</form>
					</Show>
					<Show when={!addingUpstream()}>
						<button type="button" class={`${buttonClass.ghost} mt-3`} disabled={props.busy} onClick={() => setAddingUpstream(true)}>
							Add upstream server
						</button>
					</Show>
				</div>

				<button type="button" class={`${buttonClass.ghost} mt-3`} disabled={props.busy} onClick={saveAccess}>
					Save access
				</button>
			</div>

			{/* Discord grants for this server. */}
			<div class="mb-5">
				<div class="mb-2 flex items-center gap-3">
					<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Discord grants</span>
				</div>
				<Show
					when={props.server.grants.length > 0}
					fallback={
						<p class="text-sm text-muted">
							No Discord server can reach this yet. An admin links it with{" "}
							<code class="font-mono">/eryn mcp link</code>.
						</p>
					}
				>
					<div class="divide-y divide-line border border-line-strong">
						<For each={props.server.grants}>
							{(grant) => (
								<div class="flex flex-wrap items-center gap-3 px-4 py-3">
									<span class="min-w-0 flex-1 truncate font-mono text-sm">guild {grant.guildId}</span>
									<button
										type="button"
										class={buttonClass.danger}
										disabled={props.busy}
										onClick={() => revokeGrant(grant.guildId)}
									>
										Revoke
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>

			<Code title="Harness config" value={harnessConfig()} />
		</div>
	);
}
