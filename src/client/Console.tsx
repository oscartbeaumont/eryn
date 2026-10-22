import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { capture } from "./analytics";
import {
	fetchModels,
	fetchProviders,
	fetchSetup,
	oauth,
	saveGuild,
	type AvailableGuild,
	type Guild,
	type GuildConnection,
	type ModelOption,
	type OAuthAttempt,
	type Provider,
	type ProviderField,
	type ProviderMethod,
	type SetupData,
} from "./api";
import { Combobox } from "./Combobox";
import { installUrl } from "./discord";
import { A, buttonClass, Chip, Footer, Header, Kicker, Notice, SecretInput } from "./ui";

/** A server Eryn cannot run in yet, because no provider is connected. */
function needsProvider(guild: Guild): boolean {
	return !guild.configured;
}

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

export default function Console() {
	const [data, setData] = createSignal<SetupData>();
	const [notice, setNotice] = createSignal<NoticeState | undefined>(redirectNotice());

	async function reload() {
		try {
			setData(await fetchSetup());
		} catch (error) {
			setNotice({ kind: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}
	// One-time load; `reload` is re-run after each successful save.
	void reload();

	const flash = (kind: NoticeState["kind"], message: string) => setNotice({ kind, message });

	return (
		<>
			<Header account={data()?.account} />
			<main class="flex-1">
				<section class="mx-auto w-[min(820px,92vw)] py-12">
					<Show when={notice()}>{(current) => <Notice kind={current().kind}>{current().message}</Notice>}</Show>

					<Show when={data()} fallback={<p class="font-mono text-sm text-faint">Loading…</p>}>
						{(loaded) => (
							<Show when={loaded().signedIn} fallback={<SignIn />}>
								<Kicker>Bot</Kicker>
								<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
									Your bot
								</h1>

								<Show when={(loaded().guilds ?? []).filter(needsProvider).length}>
									{(count) => (
										<p class="mb-7 border border-danger/45 px-4 py-3.5 text-sm text-muted">
											<strong class="font-semibold text-danger">
												Offline in {count()} {count() === 1 ? "server" : "servers"}.
											</strong>{" "}
											Eryn will not answer there until a provider is connected.
										</p>
									)}
								</Show>

								<Show
									when={(loaded().guilds ?? []).length > 0}
									fallback={
										<p class="max-w-[62ch] text-muted">
											Add Eryn to a Discord server, then connect a provider. Eryn stays offline in a
											server until one is set.
										</p>
									}
								>
									<div class="flex flex-col gap-4">
										<For each={loaded().guilds ?? []}>
											{(guild) => (
												<GuildCard
													guild={guild}
													githubConfigured={Boolean(loaded().githubConfigured)}
													onResult={(kind, message) => {
														flash(kind, message);
														void reload();
													}}
												/>
											)}
										</For>
									</div>
								</Show>

								<AddServers guilds={loaded().available ?? []} />
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
			<Kicker>Bot</Kicker>
			<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">Connect your bot</h1>
			<p class="mb-8 max-w-[62ch] text-muted">
				Sign in with Discord to see the servers you administer, then connect a provider — OpenCode Go, OpenRouter, or
				any other — so Eryn can answer in them.
			</p>
			<div class="flex flex-wrap gap-3">
				<A href="/auth/discord" external class={buttonClass.primary}>
					Sign in with Discord
				</A>
			</div>
		</>
	);
}

/** A guild icon, or its initial when Discord has none. */
function GuildAvatar(props: { guild: { id: string; name: string; icon: string | null } }) {
	return (
		<Show
			when={props.guild.icon}
			fallback={
				<span class="grid size-11 flex-none place-items-center border border-line-strong bg-surface-2 font-mono text-lg font-semibold">
					{props.guild.name.slice(0, 1).toUpperCase()}
				</span>
			}
		>
			{(icon) => (
				<img
					class="size-11 flex-none border border-line-strong object-cover"
					src={`https://cdn.discordapp.com/icons/${props.guild.id}/${icon()}.png?size=64`}
					alt=""
					width="44"
					height="44"
				/>
			)}
		</Show>
	);
}

/** Servers Eryn is not in yet, revealed on demand so the console stays clean. */
function AddServers(props: { guilds: AvailableGuild[] }) {
	const [open, setOpen] = createSignal(false);
	return (
		<Show when={props.guilds.length > 0}>
			<div class="mt-8">
				<button
					type="button"
					class={buttonClass.ghost}
					onClick={() => setOpen(!open())}
					aria-expanded={open() ? "true" : "false"}
				>
					{open() ? "Close" : `Add Eryn to a server (${props.guilds.length})`}
				</button>
				{/* A 0fr→1fr grid row animates height without measuring anything. */}
				<div
					class="grid transition-[grid-template-rows] duration-300 ease-out"
					style={{ "grid-template-rows": open() ? "1fr" : "0fr" }}
				>
					<div class="overflow-hidden" inert={!open()}>
						<div class={`pt-4 transition-opacity duration-300 ${open() ? "opacity-100" : "opacity-0"}`}>
							<div class="divide-y divide-line border border-line">
								<For each={props.guilds}>
									{(guild) => (
										<div class="flex items-center gap-3.5 px-5 py-4">
											<GuildAvatar guild={guild} />
											<span class="font-semibold">{guild.name}</span>
											<a
												href={installUrl(guild.id)}
												target="_blank"
												rel="noreferrer"
												class={`${buttonClass.ghost} ml-auto`}
											>
												Add
											</a>
										</div>
									)}
								</For>
							</div>
						</div>
					</div>
				</div>
			</div>
		</Show>
	);
}

/** The label for a flow, so the same provider can offer several. */
function methodLabel(method: ProviderMethod): string {
	return method.label?.trim() || (method.type === "key" ? "API key" : method.type);
}

/**
 * One input a provider's flow asks for.
 *
 * These are declared by the provider, not by Eryn, so a provider that needs an
 * extra detail gets a form without a change here. A conditional field is left
 * blank rather than hidden, and blank answers are simply not sent — which is
 * exactly how the provider's own validation reads them.
 */
function ProviderFieldInput(props: { field: ProviderField }) {
	// A conditional field cannot be required up front: whether it applies at all
	// depends on another answer.
	const required = () => Boolean(props.field.required) && !props.field.when?.length;
	return (
		<label class="block">
			<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
				{props.field.title ?? props.field.key}
			</span>
			<Show
				when={props.field.options?.length}
				fallback={
					<Show
						when={props.field.type === "boolean"}
						fallback={
							<input
								type={props.field.type === "number" || props.field.type === "integer" ? "number" : "text"}
								name={props.field.key}
								value={props.field.default === undefined ? "" : String(props.field.default)}
								placeholder={props.field.placeholder}
								required={required()}
								spellcheck={false}
								class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
							/>
						}
					>
						<input
							type="checkbox"
							name={props.field.key}
							checked={props.field.default === true}
							class="size-4 border border-line-strong bg-bg"
						/>
					</Show>
				}
			>
				<select
					name={props.field.key}
					required={required()}
					class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
				>
					<option value="">Choose…</option>
					<For each={props.field.options ?? []}>
						{(option) => <option value={option.value}>{option.label}</option>}
					</For>
				</select>
			</Show>
			<Show when={props.field.description}>
				{(description) => <span class="mt-1 block text-xs text-faint">{description()}</span>}
			</Show>
		</label>
	);
}

/** What a flow's form was filled with, with anything left blank omitted. */
function formAnswer(form: HTMLFormElement, method: ProviderMethod): Record<string, unknown> {
	const data = new FormData(form);
	const answer: Record<string, unknown> = {};
	for (const field of method.fields ?? []) {
		if (field.type === "boolean") {
			answer[field.key] = data.get(field.key) !== null;
			continue;
		}
		const value = String(data.get(field.key) ?? "").trim();
		// A blank answer is not an answer: a provider treats a missing conditional
		// field as inactive, which is what leaving it blank should mean.
		if (!value) continue;
		answer[field.key] = field.type === "number" || field.type === "integer" ? Number(value) : value;
	}
	return answer;
}

function GuildCard(props: {
	guild: Guild;
	githubConfigured: boolean;
	onResult: (kind: NoticeState["kind"], message: string) => void;
}) {
	const [busy, setBusy] = createSignal(false);
	const [model, setModel] = createSignal(props.guild.model);
	/** Which provider the picker is showing models for. */
	const [provider, setProvider] = createSignal(providerOf(props.guild.model));
	const [models, setModels] = createSignal<ModelOption[]>([]);
	const [catalogue, setCatalogue] = createSignal<"loading" | "ready" | "error">("loading");
	const [catalogueError, setCatalogueError] = createSignal<string>();
	const [providers, setProviders] = createSignal<Provider[]>([]);
	const [providersError, setProvidersError] = createSignal<string>();

	/**
	 * The catalogue comes from this server's own OpenCode instance, so it is
	 * exactly the set a turn could use. It only covers providers that are
	 * connected, because a model whose provider has no credential cannot run.
	 */
	async function loadModels() {
		if (!props.guild.configured) {
			setCatalogue("ready");
			return;
		}
		setCatalogue("loading");
		try {
			const result = await fetchModels(props.guild.id);
			setModels(result.models);
			setCatalogue("ready");
		} catch (error) {
			setCatalogueError(error instanceof Error ? error.message : String(error));
			setCatalogue("error");
		}
	}

	/** Every provider this deployment offers, with the flows each one supports. */
	async function loadProviders() {
		try {
			const result = await fetchProviders(props.guild.id);
			setProviders(result.integrations);
			setProvidersError(result.error);
		} catch (error) {
			// The list is only needed to add or name a provider; failing to read it
			// must not take the rest of the card down with it, but it is said out
			// loud rather than shown as an empty list.
			setProviders([]);
			setProvidersError(error instanceof Error ? error.message : String(error));
		}
	}

	void loadModels();
	void loadProviders();

	async function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const formData = new FormData(form);
		setBusy(true);
		try {
			const result = await saveGuild({
				action: "save",
				guildId: props.guild.id,
				model: model(),
				githubRepo: String(formData.get("github_repo") ?? ""),
			});
			props.onResult("ok", result.message ?? "Saved.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function onDisconnect(connection: GuildConnection) {
		const name = providerName(connection.integrationID);
		if (!confirm(`Disconnect ${name} for this server? Eryn cannot use its models afterwards.`)) return;
		setBusy(true);
		try {
			const result = await saveGuild({
				action: "disconnect",
				guildId: props.guild.id,
				integrationId: connection.integrationID,
			});
			capture("server_key_removed", { provider: connection.integrationID });
			props.onResult("ok", result.message ?? "Disconnected.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	function providerName(integrationID: string): string {
		return providers().find((provider) => provider.id === integrationID)?.name ?? integrationID;
	}

	/** The provider a model reference names, which is the part before the first slash. */
	function providerOf(reference: string): string {
		const at = reference.indexOf("/");
		return at > 0 ? reference.slice(0, at) : reference;
	}

	/** A provider's display name, from the catalogue the console already loaded. */
	function providerLabel(id: string): string {
		const name = providers().find((entry) => entry.id === id)?.name;
		return name && name !== id ? name : id;
	}

	/**
	 * The catalogue grouped by provider, the ones this server can use first.
	 *
	 * Grouping is what makes a catalogue of a few thousand models usable: a
	 * provider is chosen first and only its models are ever listed.
	 */
	const catalogueProviders = createMemo(() => {
		const grouped = new Map<string, ModelOption[]>();
		for (const entry of models()) {
			const list = grouped.get(entry.provider) ?? [];
			list.push(entry);
			grouped.set(entry.provider, list);
		}
		return [...grouped.entries()]
			.map(([id, list]) => ({
				id,
				connected: list.some((entry) => entry.connected),
				usable: list.filter((entry) => entry.enabled).length,
				total: list.length,
			}))
			.sort(
				(a, b) =>
					Number(b.connected) - Number(a.connected) ||
					Number(b.usable) - Number(a.usable) ||
					a.id.localeCompare(b.id),
			);
	});

	/** The provider choices, including one the catalogue does not describe. */
	const providerChoices = createMemo(() => {
		const choices = catalogueProviders().map((entry) => ({
			id: entry.id,
			label: `${providerLabel(entry.id)} — ${entry.total} model${entry.total === 1 ? "" : "s"}${entry.connected ? ", connected" : ""}`,
		}));
		if (choices.some((choice) => choice.id === provider())) return choices;
		return [{ id: provider(), label: `${provider()} — not in this catalogue` }, ...choices];
	});

	/** Only the chosen provider's models, named without their provider prefix. */
	const modelChoices = createMemo(() => {
		const prefix = `${provider()}/`;
		return models()
			.filter((entry) => entry.provider === provider())
			.map((entry) => ({
				id: entry.id,
				name: entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id,
				note: entry.name,
				disabled: !entry.enabled,
			}));
	});

	/**
	 * Show another provider's models.
	 *
	 * The model chosen from the last one is not in this list, so the first this
	 * provider can actually run is selected rather than leaving a reference that
	 * belongs to a provider nobody was looking at.
	 */
	function chooseProvider(id: string) {
		setProvider(id);
		const candidates = models().filter((entry) => entry.provider === id);
		if (candidates.some((entry) => entry.id === model())) return;
		const next = candidates.find((entry) => entry.enabled) ?? candidates[0];
		if (next) setModel(next.id);
	}

	/** One line under the picker explaining what the list currently is. */
	function catalogueHint(): string {
		if (!props.guild.configured) return "Connect a provider to load the models it can reach.";
		if (catalogue() === "loading") return "Loading models from this server's OpenCode instance…";
		if (catalogue() === "error") return `Could not load models: ${catalogueError()}`;
		const list = models().filter((entry) => entry.provider === provider());
		if (list.length === 0) return "This provider reported no models. You can still type any provider/model reference.";
		const usable = list.filter((entry) => entry.enabled).length;
		// Every provider is listed, so the useful number is how many of this one's
		// models can actually run — the rest show so a configured provider is not
		// invisible, and this says which one to connect.
		if (usable === 0) {
			return `${list.length} models from ${providerLabel(provider())}, none usable — connect it above to use them.`;
		}
		return `${list.length} models from ${providerLabel(provider())}, ${usable} usable. Search, or type any provider/model reference.`;
	}

	return (
		<div class="border border-line bg-surface p-6">
			<div class="mb-5 flex items-center gap-3.5">
				<GuildAvatar guild={props.guild} />
				<div class="font-semibold">{props.guild.name}</div>
				<Chip tone={props.guild.configured ? "ok" : "danger"}>{props.guild.configured ? "Ready" : "Offline"}</Chip>
			</div>

			<Show
				when={props.guild.configured}
				fallback={
					<div class="mb-5 border border-dashed border-danger/45 px-4 py-3.5">
						<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-danger">Not ready</div>
						<p class="mt-1 text-sm text-muted">
							Eryn is offline in this server and will not answer until a provider is connected. Inference runs on
							your own key, so nothing is billed to the operator.
						</p>
					</div>
				}
			>
				<div class="mb-5 divide-y divide-line border border-line-strong bg-bg">
					<For each={props.guild.connections}>
						{(connection) => (
							<div class="flex flex-wrap items-center gap-4 px-4 py-3.5">
								<div class="min-w-0">
									<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
										{providerName(connection.integrationID)}
									</div>
									<div class="mt-1 font-mono text-sm text-fg">
										{connection.prefix ? `${connection.prefix}…` : "connected"}
									</div>
								</div>
								<button
									type="button"
									class={`${buttonClass.danger} ml-auto`}
									onClick={() => void onDisconnect(connection)}
									disabled={busy()}
								>
									Disconnect
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>

			<AddProvider
				guild={props.guild}
				providers={providers()}
				error={providersError()}
				onResult={(kind, message) => {
					props.onResult(kind, message);
				}}
			/>

			<form onSubmit={onSubmit}>
				<div class="mt-5 mb-2 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<label class="block">
						<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Provider</span>
						{/* A select rather than a search box: there are a hundred or so, and
						    a chosen provider is a filter, not a value that gets submitted. */}
						<select
							value={provider()}
							disabled={!props.guild.configured}
							onChange={(event) => chooseProvider(event.currentTarget.value)}
							class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg disabled:cursor-not-allowed disabled:border-line disabled:text-faint"
						>
							<For each={providerChoices()}>{(choice) => <option value={choice.id}>{choice.label}</option>}</For>
						</select>
					</label>
					<label class="block">
						<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Model</span>
						<Combobox
							name="model"
							value={model()}
							options={modelChoices()}
							disabled={!props.guild.configured}
							placeholder={props.guild.configured ? "Search models…" : "Connect a provider first"}
							emptyText={models().length === 0 ? "No models loaded." : "No model matches that search."}
							onInput={setModel}
						/>
					</label>
				</div>
				<span class="mb-3.5 block text-xs text-faint">{catalogueHint()}</span>

				<Show
					when={props.githubConfigured}
					fallback={
						<p class="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
							GitHub is not configured on this deployment.
						</p>
					}
				>
					<Show when={!props.guild.githubInstalled && props.guild.githubInstallUrl}>
						{(url) => (
							<div class="mb-3.5">
								<a href={url()} target="_blank" rel="noreferrer" class={buttonClass.small}>
									Install GitHub App
								</a>
							</div>
						)}
					</Show>
					<label class="mb-3.5 block">
						<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
							GitHub repository (owner/name)
						</span>
						<input
							type="text"
							name="github_repo"
							value={props.guild.githubRepo ?? ""}
							placeholder="owner/repo"
							spellcheck={false}
							class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
						/>
					</label>
				</Show>

				<div class="flex flex-wrap items-center gap-3">
					<button type="submit" class={buttonClass.primary} disabled={busy()}>
						Save changes
					</button>
				</div>
			</form>
		</div>
	);
}

/**
 * Connect a provider, by whichever flow it offers.
 *
 * The provider list is the host's own catalogue, so nothing here is specific to
 * a provider: a key is pasted, or a sign-in is started and polled, and either
 * way the credential ends up on the backend and never in this page.
 */
function AddProvider(props: {
	guild: Guild;
	providers: Provider[];
	/** Why the catalogue could not be read, when it could not. */
	error?: string;
	onResult: (kind: NoticeState["kind"], message: string) => void;
}) {
	const [open, setOpen] = createSignal(false);
	const [selected, setSelected] = createSignal<Provider | undefined>();
	const [query, setQuery] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [attempt, setAttempt] = createSignal<OAuthAttempt | undefined>();
	const [attemptError, setAttemptError] = createSignal<string>();
	let poll: ReturnType<typeof setInterval> | undefined;
	onCleanup(() => poll && clearInterval(poll));

	/** Only providers with a flow this deployment can run are offered. */
	const connectable = () => props.providers.filter((provider) => provider.methods.some((method) => method.supported));

	function choose(provider: Provider | undefined) {
		stopPolling();
		setAttempt(undefined);
		setAttemptError(undefined);
		setQuery(provider?.name ?? "");
		setSelected(provider);
	}

	function stopPolling() {
		if (poll) clearInterval(poll);
		poll = undefined;
	}

	async function connectKey(event: SubmitEvent) {
		event.preventDefault();
		const provider = selected();
		if (!provider) return;
		const form = event.currentTarget as HTMLFormElement;
		const apiKey = String(new FormData(form).get("api_key") ?? "").trim();
		if (!apiKey) return;
		setBusy(true);
		try {
			const result = await saveGuild({
				action: "connect",
				guildId: props.guild.id,
				integrationId: provider.id,
				apiKey,
			});
			capture("server_key_saved", { provider: provider.id });
			choose(undefined);
			setOpen(false);
			props.onResult("ok", result.message ?? "Connected.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	/** Start a sign-in and watch it, since the host finishes it on its own. */
	async function signIn(event: SubmitEvent, method: ProviderMethod) {
		event.preventDefault();
		const provider = selected();
		if (!provider || !method.id) return;
		stopPolling();
		setAttemptError(undefined);
		setBusy(true);
		try {
			const result = await oauth({
				action: "start",
				guildId: props.guild.id,
				integrationId: provider.id,
				methodId: method.id,
				answer: formAnswer(event.currentTarget as HTMLFormElement, method),
			});
			if (!result.attempt) throw new Error("The sign-in could not be started.");
			setAttempt(result.attempt);
			poll = setInterval(() => void checkStatus(result.attempt!.attemptID), 2_000);
		} catch (error) {
			setAttemptError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function checkStatus(attemptID: string) {
		const provider = selected();
		if (!provider) return;
		try {
			const result = await oauth({
				action: "status",
				guildId: props.guild.id,
				integrationId: provider.id,
				attemptId: attemptID,
			});
			const status = result.status;
			if (!status || status.status === "pending") return;
			stopPolling();
			if (status.status === "complete") {
				choose(undefined);
				setOpen(false);
				props.onResult("ok", `${provider.name} connected.`);
				return;
			}
			setAttemptError(status.message ?? `The sign-in ${status.status}.`);
		} catch (error) {
			stopPolling();
			setAttemptError(error instanceof Error ? error.message : String(error));
		}
	}

	async function finishWithCode(event: SubmitEvent) {
		event.preventDefault();
		const provider = selected();
		const current = attempt();
		if (!provider || !current) return;
		const code = String(new FormData(event.currentTarget as HTMLFormElement).get("code") ?? "").trim();
		if (!code) return;
		setBusy(true);
		try {
			await oauth({
				action: "complete",
				guildId: props.guild.id,
				integrationId: provider.id,
				attemptId: current.attemptID,
				code,
			});
			stopPolling();
			choose(undefined);
			setOpen(false);
			props.onResult("ok", `${provider.name} connected.`);
		} catch (error) {
			setAttemptError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<button
				type="button"
				class={buttonClass.ghost}
				onClick={() => setOpen(!open())}
				aria-expanded={open() ? "true" : "false"}
			>
				{open() ? "Close" : "Connect a provider"}
			</button>

			{/* A 0fr→1fr grid row animates height without measuring anything. */}
			<div class="grid transition-[grid-template-rows] duration-300 ease-out" style={{ "grid-template-rows": open() ? "1fr" : "0fr" }}>
				<div class="overflow-hidden" inert={!open()}>
					<div class={`pt-4 transition-opacity duration-300 ${open() ? "opacity-100" : "opacity-0"}`}>
						<label class="mb-3.5 block">
							<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Provider</span>
							<Combobox
								name="provider"
								value={query()}
								options={connectable().map((provider) => ({
									id: provider.id,
									name: provider.name,
									note: provider.connected ? "already connected" : provider.id,
								}))}
								placeholder="Search providers…"
								emptyText={
									props.error
										? `The provider list could not be read: ${props.error}`
										: props.providers.length === 0
											? "No providers are available to this server yet."
											: query().trim()
												? "No provider matches that search."
												: "No provider here can be connected from this deployment."
								}
								onInput={setQuery}
								onPick={(option) => choose(props.providers.find((provider) => provider.id === option.id))}
							/>
						</label>

						<Show when={selected()}>
							{(provider) => (
								<div class="flex flex-col gap-4 border border-line-strong bg-bg p-4">
									<For each={provider().methods.filter((method) => method.supported)}>
										{(method) => (
											<Show
												when={method.type === "key"}
												fallback={
													<div class="flex flex-col gap-3">
														<form class="flex flex-col gap-3" onSubmit={(event) => void signIn(event, method)}>
															<For each={method.fields ?? []}>
																{(field) => <ProviderFieldInput field={field} />}
															</For>
															<button type="submit" class={buttonClass.primary} disabled={busy()}>
																{methodLabel(method)}
															</button>
														</form>
														<Show when={attempt()}>
															{(current) => (
																<div class="flex flex-col gap-3">
																	<p class="text-sm text-muted">{current().instructions}</p>
																	<a href={current().url} target="_blank" rel="noreferrer" class={buttonClass.small}>
																		Open the sign-in page
																	</a>
																	<Show when={current().mode === "code"}>
																		<form class="flex flex-wrap items-end gap-3" onSubmit={finishWithCode}>
																			<label class="min-w-0 flex-1">
																				<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
																					Code
																				</span>
																				<SecretInput name="code" placeholder="Paste the code" />
																			</label>
																			<button type="submit" class={buttonClass.primary} disabled={busy()}>
																				Finish
																			</button>
																		</form>
																	</Show>
																	<p class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
																		Waiting for the provider…
																	</p>
																</div>
															)}
														</Show>
													</div>
												}
											>
												<form class="flex flex-wrap items-end gap-3" onSubmit={connectKey}>
													<label class="min-w-0 flex-1">
														<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
															{methodLabel(method)}
														</span>
														<SecretInput name="api_key" placeholder="Paste the key" />
													</label>
													<button type="submit" class={buttonClass.primary} disabled={busy()}>
														Connect
													</button>
												</form>
											</Show>
										)}
									</For>
									<Show when={attemptError()}>
										{(message) => <p class="text-sm text-danger">{message()}</p>}
									</Show>
								</div>
							)}
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
}
