import { createSignal, For, Show } from "solid-js";
import { capture } from "./analytics";
import { fetchModels, fetchSetup, saveGuild, type AvailableGuild, type Guild, type ModelOption, type SetupData } from "./api";
import { installUrl } from "./discord";
import { ModelSelect } from "./ModelSelect";
import { A, buttonClass, Chip, Footer, Header, Kicker, Notice } from "./ui";

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
								<Kicker>Console</Kicker>
								<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
									Your servers
								</h1>

								<Show
									when={(loaded().guilds ?? []).length > 0}
									fallback={
										<p class="max-w-[62ch] text-muted">
											Add Eryn to a server to get started, then connect its OpenCode Go key.
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
			<Kicker>Console</Kicker>
			<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">Connect a server</h1>
			<p class="mb-8 max-w-[62ch] text-muted">
				Sign in with Discord to see the servers you administer, then add an OpenCode Go key to run inference on your own
				account.
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
					{open() ? "Close" : `Add a server (${props.guilds.length})`}
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

function GuildCard(props: {
	guild: Guild;
	githubConfigured: boolean;
	onResult: (kind: NoticeState["kind"], message: string) => void;
}) {
	const [busy, setBusy] = createSignal(false);
	const [model, setModel] = createSignal(props.guild.model);
	/** Set while the key field is revealed for a server that already has one. */
	const [replacing, setReplacing] = createSignal(false);
	const [models, setModels] = createSignal<ModelOption[]>([]);
	const [catalogue, setCatalogue] = createSignal<"loading" | "ready" | "error">("loading");
	const [catalogueError, setCatalogueError] = createSignal<string>();

	/**
	 * The catalogue comes from this server's own OpenCode instance, so it is
	 * exactly the set a turn could use. Without a key there is nothing to ask,
	 * so the picker stays disabled rather than making something up.
	 */
	async function loadModels() {
		if (!props.guild.configured) return;
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
	void loadModels();

	async function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const formData = new FormData(form);
		setBusy(true);
		try {
			const result = await saveGuild({
				action: "save",
				guildId: props.guild.id,
				apiKey: String(formData.get("api_key") ?? ""),
				model: model(),
				githubRepo: String(formData.get("github_repo") ?? ""),
			});
			capture("server_key_saved", { model: model() });
			props.onResult("ok", result.message ?? "Saved.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		if (!confirm("Remove the key for this server? Eryn will stop running here until a new one is added.")) return;
		setBusy(true);
		try {
			const result = await saveGuild({ action: "remove", guildId: props.guild.id });
			capture("server_key_removed");
			props.onResult("ok", result.message ?? "Removed.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	/** One line under the picker explaining what the list currently is. */
	function catalogueHint(): string {
		if (!props.guild.configured) return "Add an OpenCode Go key to load the models it can reach.";
		if (catalogue() === "loading") return "Loading models from this server's OpenCode instance…";
		if (catalogue() === "error") return `Could not load models: ${catalogueError()}`;
		if (models().length === 0) return "This key reported no models. You can still type a reference.";
		return `${models().length} models available to this key. Search, or type any provider/model reference.`;
	}

	return (
		<div class="border border-line bg-surface p-6">
			<div class="mb-5 flex items-center gap-3.5">
				<GuildAvatar guild={props.guild} />
				<div class="font-semibold">{props.guild.name}</div>
				<Chip on={props.guild.configured}>{props.guild.configured ? "Key set" : "Key required"}</Chip>
			</div>

			<form onSubmit={onSubmit}>
				<Show
					when={props.guild.configured}
					fallback={
						<div class="mb-5 border border-dashed border-line-strong px-4 py-3.5">
							<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">OpenCode Go API key</div>
							<p class="mt-1 text-sm text-muted">
								Required. Eryn runs inference on your own key — nothing is billed to the operator.
							</p>
						</div>
					}
				>
					<div class="mb-5 flex flex-wrap items-center gap-4 border border-line-strong bg-bg px-4 py-3.5">
						<div class="min-w-0">
							<div class="font-mono text-[11px] uppercase tracking-[0.12em] text-faint">OpenCode Go API key</div>
							<div class="mt-1 font-mono text-sm text-fg">
								{props.guild.keyPrefix ? `${props.guild.keyPrefix}…` : "set"}
							</div>
						</div>
						<div class="ml-auto flex flex-wrap gap-2">
							<button type="button" class={buttonClass.ghost} onClick={() => setReplacing(!replacing())} disabled={busy()}>
								{replacing() ? "Cancel" : "Replace"}
							</button>
							<button type="button" class={buttonClass.danger} onClick={() => void onRemove()} disabled={busy()}>
								Clear
							</button>
						</div>
					</div>
				</Show>

				<Show when={!props.guild.configured || replacing()}>
					<label class="mb-3.5 block">
						<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
							{props.guild.configured ? "New key — blank keeps the current one" : "OpenCode Go API key"}
						</span>
						<input
							type="password"
							name="api_key"
							placeholder="oc_sk_…"
							autocomplete="off"
							spellcheck={false}
							class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
						/>
					</label>
				</Show>

				<label class="mb-3.5 block">
					<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Model</span>
					<ModelSelect
						name="model"
						value={model()}
						models={models()}
						disabled={!props.guild.configured}
						placeholder={props.guild.configured ? "Search models…" : "Add a key first"}
						onInput={setModel}
					/>
					<span class="mt-2 block text-xs text-faint">{catalogueHint()}</span>
				</label>

				<Show
					when={props.githubConfigured}
					fallback={<p class="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-faint">GitHub is not configured on this deployment.</p>}
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
						{props.guild.configured ? "Save changes" : "Save key"}
					</button>
				</div>
			</form>
		</div>
	);
}
