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
				}
			: undefined,
	};
}

export default function Servers() {
	const [data, setData] = createSignal<ServersData>();
	const [accounts, setAccounts] = createSignal<AccountSummary[]>([]);
	const [groups, setGroups] = createSignal<ToolGroup[]>([]);
	const [notice, setNotice] = createSignal<NoticeState>();
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

	/** Only the groups the accounts assigned to this server can act with. */
	const visibleGroups = () => {
		const providers = new Set(props.server.accounts.map((account) => account.provider));
		return props.groups.filter((group) => {
			if (group.id === "builtin") return true;
			if (group.id === "discord") return providers.has("discord");
			if (group.id === "github") return providers.has("github");
			if (group.id === "google_calendar") return providers.has("google");
			return false;
		});
	};

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

	function saveAccounts() {
		props.onMutate({ action: "accounts", id: props.server.id, accountIds: selected() }, "Accounts saved.");
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
			const tools: ToolOverride = {};
			if (include.size) tools.include = [...include];
			if (exclude.size) tools.exclude = [...exclude];
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
			for (const group of visibleGroups()) groups[group.id] = level;
			return { groups, tools: current.tools };
		});
	}

	function saveTools() {
		props.onMutate({ action: "tools", id: props.server.id, tools: access() }, "Tools saved.");
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

			{/* Accounts assigned to this server's tools. */}
			<div class="mb-5">
				<div class="mb-2 flex items-center gap-3">
					<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Accounts</span>
				</div>
				<Show
					when={props.accounts.length > 0}
					fallback={
						<p class="text-sm text-muted">
							No accounts connected yet. <A href="/console/accounts" class="border-b border-line-strong text-fg">Connect one</A> to give this server something to act with.
						</p>
					}
				>
					<div class="divide-y divide-line border border-line-strong">
						<For each={props.accounts}>
							{(account) => (
								<label class="flex cursor-pointer items-center gap-3 px-4 py-3">
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
							)}
						</For>
					</div>
					<button type="button" class={`${buttonClass.ghost} mt-3`} disabled={props.busy} onClick={saveAccounts}>
						Save accounts
					</button>
				</Show>
			</div>

			{/* Tool access, by group and per tool. Gated on an assigned account. */}
			<div class="mb-5">
				<div class="mb-2 flex items-center gap-3">
					<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Tools</span>
					<Show when={props.server.accounts.length > 0}>
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
				<Show
					when={props.server.accounts.length > 0}
					fallback={
						<p class="text-sm text-muted">
							Assign at least one account above, then save, to choose the tools this server exposes. The
							groups available depend on which providers those accounts belong to.
						</p>
					}
				>
					<Show
						when={visibleGroups().length > 0}
						fallback={<p class="text-sm text-muted">None of the assigned accounts has a tool group on this deployment.</p>}
					>
						<div class="flex flex-col gap-4">
							<For each={visibleGroups()}>
							{(group) => (
								<div class="border border-line-strong bg-bg">
									<div class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
										<span class="font-mono text-sm font-semibold">{group.name}</span>
										<label class="ml-auto flex items-center gap-2">
											<span class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Group</span>
											<select
												value={access().groups[group.id] ?? "none"}
												onChange={(event) => setGroup(group.id, toLevel(event.currentTarget.value))}
												class="border border-line-strong bg-surface px-2 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
											>
												<For each={LEVELS}>
													{(level) => <option value={level}>{LEVEL_LABELS[level]}</option>}
												</For>
											</select>
										</label>
									</div>
									<Show when={group.tools.length > 0}>
										<details class="px-4 py-3">
											<summary class="cursor-pointer font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
												Per-tool overrides ({group.tools.length})
											</summary>
											<div class="mt-3 divide-y divide-line border border-line">
												<For each={group.tools}>
													{(tool) => (
														<div class="flex flex-wrap items-center gap-3 px-3 py-2.5">
															<div class="min-w-0 flex-1">
																<div class="font-mono text-xs text-fg">{tool.name}</div>
																<div class="text-xs text-muted">{tool.title}</div>
															</div>
															<span class="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
																{tool.access}
															</span>
															<select
																value={overrideMode(tool.name)}
																onChange={(event) =>
																	setOverride(
																		tool.name,
																		event.currentTarget.value === "include"
																			? "include"
																			: event.currentTarget.value === "exclude"
																				? "exclude"
																				: "group",
																	)
																}
																class="border border-line-strong bg-surface px-2 py-2 font-mono text-xs text-fg outline-none focus:border-fg"
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
							)}
						</For>
						</div>
						<button type="button" class={`${buttonClass.ghost} mt-3`} disabled={props.busy} onClick={saveTools}>
							Save tools
						</button>
					</Show>
				</Show>
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
