import { createSignal, For, Show } from "solid-js";
import { capture } from "./analytics";
import {
	accountsAction,
	fetchAccounts,
	type AccountSummary,
	type AccountsAction,
	type AccountsData,
	type ProviderId,
	type ProviderSummary,
} from "./api";
import { session } from "./session";
import { buttonClass, Chip, Footer, Header, Kicker, Notice, SecretInput } from "./ui";

interface NoticeState {
	kind: "ok" | "error";
	message: string;
}

/** A one-time notice carried in on redirect (from an OAuth callback). */
function redirectNotice(): NoticeState | undefined {
	const params = new URLSearchParams(window.location.search);
	const ok = params.get("ok");
	if (ok) return { kind: "ok", message: ok };
	const error = params.get("error");
	if (error) return { kind: "error", message: error };
	return undefined;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A provider's id, its display name, and the accounts under it. */
interface ProviderGroup {
	id: ProviderId;
	name: string;
	accounts: AccountSummary[];
}

function groupAccounts(accounts: AccountSummary[], providers: ProviderSummary[]): ProviderGroup[] {
	const names = new Map(providers.map((provider) => [provider.id, provider.name]));
	const grouped = new Map<ProviderId, AccountSummary[]>();
	for (const account of accounts) {
		const list = grouped.get(account.provider) ?? [];
		list.push(account);
		grouped.set(account.provider, list);
	}
	return [...grouped.entries()].map(([id, list]) => ({ id, name: names.get(id) ?? id, accounts: list }));
}

export default function Accounts() {
	const [data, setData] = createSignal<AccountsData>();
	const [notice, setNotice] = createSignal<NoticeState | undefined>(redirectNotice());
	const [busy, setBusy] = createSignal(false);

	async function reload() {
		try {
			setData(await fetchAccounts());
		} catch (error) {
			setNotice({ kind: "error", message: describe(error) });
		}
	}
	void reload();

	const flash = (kind: NoticeState["kind"], message: string) => setNotice({ kind, message });

	/** Run an account action, following a returned OAuth URL when there is one. */
	async function mutate(action: AccountsAction, success: string) {
		setBusy(true);
		try {
			const result = await accountsAction(action);
			if (result.url) {
				window.location.href = result.url;
				return;
			}
			capture(`account_${action.action}`);
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
								<Kicker>Accounts</Kicker>
								<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
									Your accounts
								</h1>
								<p class="mb-8 max-w-[62ch] text-muted">
									Connect the accounts your hosted MCP servers act through. You can connect as many as you like —
									each server is assigned the ones it may use, so a second GitHub account is a normal thing to have.
								</p>

								<h2 class="mb-4 font-mono text-[15px] font-semibold">Connect</h2>
								<ConnectProviders
									providers={loaded().providers}
									busy={busy()}
									onConnect={(action, success) => void mutate(action, success)}
								/>

								<h2 class="mb-4 mt-12 font-mono text-[15px] font-semibold">Connected</h2>
								<Show
									when={loaded().accounts.length > 0}
									fallback={
										<p class="border border-dashed border-line-strong px-4 py-3.5 text-sm text-muted">
											No accounts connected yet. Connect one above to give your MCP servers something to act with.
										</p>
									}
								>
									<div class="flex flex-col gap-6">
										<For each={groupAccounts(loaded().accounts, loaded().providers)}>
											{(group) => (
												<div>
													<div class="mb-2 flex items-center gap-3">
														<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
															{group.name}
														</span>
														<span class="font-mono text-[11px] text-faint">
															{group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}
														</span>
													</div>
													<div class="divide-y divide-line border border-line bg-surface">
														<For each={group.accounts}>
															{(account) => (
																<AccountRow
																	account={account}
																	busy={busy()}
																	onMutate={(action, success) => void mutate(action, success)}
																/>
															)}
														</For>
													</div>
												</div>
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
			<Kicker>Accounts</Kicker>
			<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">Connect your accounts</h1>
			<p class="mb-8 max-w-[62ch] text-muted">
				Sign in with Discord to connect the accounts your MCP servers act through.
			</p>
			<a href="/auth/discord" class={buttonClass.primary}>
				Sign in with Discord
			</a>
		</>
	);
}

/** A one-line description of what connecting a provider gives you. */
function providerNote(id: ProviderId): string {
	if (id === "discord") return "Lets Eryn's Discord tools act as the bot, from the servers it is already in.";
	if (id === "github") return "Issues, pull requests, reviews and CI, carried by your name or Eryn's app.";
	if (id === "google") return "Google Calendar: list, read, and create or change events.";
	return "An account for Eryn's tools.";
}

/** The connect controls for every provider this deployment offers. */
function ConnectProviders(props: {
	providers: ProviderSummary[];
	busy: boolean;
	onConnect: (action: AccountsAction, success: string) => void;
}) {
	return (
		<Show
			when={props.providers.length > 0}
			fallback={
				<p class="border border-dashed border-line-strong px-4 py-3.5 text-sm text-muted">
					No account providers are available on this deployment.
				</p>
			}
		>
			<div class="divide-y divide-line border border-line bg-surface">
				<For each={props.providers}>
					{(provider) => (
						<div class="flex flex-wrap items-center gap-4 px-5 py-4">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="font-mono text-sm font-semibold">{provider.name}</span>
									<Show when={!provider.configured}>
										<Chip tone="muted">Not configured</Chip>
									</Show>
								</div>
								<p class="mt-1 text-sm text-muted">{providerNote(provider.id)}</p>
							</div>
							<ProviderActions provider={provider} busy={props.busy} onConnect={props.onConnect} />
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}

function ProviderActions(props: {
	provider: ProviderSummary;
	busy: boolean;
	onConnect: (action: AccountsAction, success: string) => void;
}) {
	const oauth = () => props.provider.connect.includes("oauth") && props.provider.configured;
	const pat = () => props.provider.connect.includes("pat");

	return (
		<div class="flex flex-wrap items-end gap-3">
			<Show when={props.provider.id === "discord"}>
				<button
					type="button"
					class={buttonClass.primary}
					disabled={props.busy}
					onClick={() => props.onConnect({ action: "add-discord" }, "Discord connected.")}
				>
					Connect Discord
				</button>
			</Show>

			<Show when={props.provider.id === "github"}>
				<Show when={oauth()}>
					<button
						type="button"
						class={buttonClass.primary}
						disabled={props.busy}
						onClick={() => props.onConnect({ action: "start-github-oauth" }, "GitHub connected.")}
					>
						Connect GitHub
					</button>
				</Show>
				<Show when={pat()}>
					<form
						class="flex flex-wrap items-end gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							const token = String(new FormData(event.currentTarget).get("token") ?? "").trim();
							if (!token) return;
							props.onConnect({ action: "add-github-pat", token }, "GitHub token connected.");
						}}
					>
						<label class="min-w-0">
							<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
								Personal access token
							</span>
							<SecretInput name="token" placeholder="github_pat_… or ghp_…" />
						</label>
						<button type="submit" class={buttonClass.primary} disabled={props.busy}>
							Connect token
						</button>
					</form>
				</Show>
				<Show when={!oauth() && !pat()}>
					<p class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
						No GitHub flow is configured on this deployment.
					</p>
				</Show>
			</Show>

			<Show when={props.provider.id === "google"}>
				<Show
					when={oauth()}
					fallback={
						<p class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
							Google is not configured on this deployment.
						</p>
					}
				>
					<button
						type="button"
						class={buttonClass.primary}
						disabled={props.busy}
						onClick={() => props.onConnect({ action: "start-google-oauth" }, "Google connected.")}
					>
						Connect Google
					</button>
				</Show>
			</Show>
		</div>
	);
}

/** A provider avatar with a lettered fallback, shared with the Discord console. */
function Avatar(props: { src?: string; name: string }) {
	return (
		<Show
			when={props.src}
			fallback={
				<span class="grid size-11 flex-none place-items-center border border-line-strong bg-surface-2 font-mono text-lg font-semibold">
					{props.name.slice(0, 1).toUpperCase()}
				</span>
			}
		>
			{(src) => (
				<img
					class="size-11 flex-none border border-line-strong object-cover"
					src={src()}
					alt=""
					width="44"
					height="44"
				/>
			)}
		</Show>
	);
}

function AccountRow(props: {
	account: AccountSummary;
	busy: boolean;
	onMutate: (action: AccountsAction, success: string) => void;
}) {
	const [editing, setEditing] = createSignal(false);
	const [label, setLabel] = createSignal(props.account.label);

	function saveLabel(event: SubmitEvent) {
		event.preventDefault();
		const next = label().trim();
		if (!next || next === props.account.label) {
			setEditing(false);
			return;
		}
		props.onMutate({ action: "label", id: props.account.id, label: next }, "Label saved.");
		setEditing(false);
	}

	function unlink() {
		if (!confirm("Unlink this account? Eryn cannot use it afterwards.")) return;
		props.onMutate({ action: "unlink", id: props.account.id }, "Account unlinked.");
	}

	return (
		<div class="flex flex-wrap items-center gap-4 px-5 py-4">
			<Avatar src={props.account.profile.avatarUrl} name={props.account.profile.name ?? props.account.profile.username} />
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<span class="font-mono text-sm font-semibold">
						{props.account.profile.name ?? props.account.profile.username}
					</span>
					<Show when={props.account.profile.name}>
						<span class="font-mono text-xs text-faint">@{props.account.profile.username}</span>
					</Show>
				</div>
				<div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-faint">
					<Show when={props.account.profile.url}>
						{(url) => (
							<a
								href={url()}
								target="_blank"
								rel="noreferrer"
								class="border-b border-line-strong text-muted hover:text-fg"
							>
								Profile ↗
							</a>
						)}
					</Show>
					<span class="font-mono">{props.account.label}</span>
				</div>
			</div>

			<Show
				when={editing()}
				fallback={
					<div class="flex flex-wrap items-center gap-2">
						<Show when={props.account.reauth}>
							<Chip tone="danger">Reconnect needed</Chip>
						</Show>
						<button
							type="button"
							class={buttonClass.ghost}
							disabled={props.busy}
							onClick={() => {
								setLabel(props.account.label);
								setEditing(true);
							}}
						>
							Relabel
						</button>
						<button type="button" class={buttonClass.danger} disabled={props.busy} onClick={unlink}>
							Unlink
						</button>
					</div>
				}
			>
				<form class="flex flex-wrap items-end gap-2" onSubmit={saveLabel}>
					<label class="min-w-0">
						<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Label</span>
						<input
							type="text"
							value={label()}
							spellcheck={false}
							class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
							onInput={(event) => setLabel(event.currentTarget.value)}
						/>
					</label>
					<button type="submit" class={buttonClass.primary} disabled={props.busy}>
						Save
					</button>
					<button type="button" class={buttonClass.ghost} onClick={() => setEditing(false)}>
						Cancel
					</button>
				</form>
			</Show>
		</div>
	);
}
