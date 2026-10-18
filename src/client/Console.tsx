import { createSignal, For, Show } from "solid-js";
import { fetchSetup, saveGuild, type AvailableGuild, type Guild, type SetupData } from "./api";
import { installUrl } from "./discord";
import { A, buttonClass, Chip, Footer, Header, Kicker, Notice } from "./ui";

const MODELS = [
	"opencode-go/deepseek-v4.1-flash",
	"opencode-go/deepseek-v4-pro",
	"opencode-go/kimi-k3",
	"opencode-go/glm-5.3",
	"opencode-go/gpt-6-luna",
	"opencode-go/claude-haiku-5-5",
];

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
				<section class="mx-auto w-[min(1080px,92vw)] py-12">
					<Show when={notice()}>{(current) => <Notice kind={current().kind}>{current().message}</Notice>}</Show>

					<Show when={data()} fallback={<p class="font-mono text-sm text-faint">Loading…</p>}>
						{(loaded) => (
							<Show when={loaded().signedIn} fallback={<SignIn />}>
								<Kicker>Console</Kicker>
								<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
									Your servers
								</h1>
								<datalist id="models">
									<For each={MODELS}>{(model) => <option value={model} />}</For>
								</datalist>

								<Show
									when={(loaded().guilds ?? []).length > 0}
									fallback={
										<p class="max-w-[62ch] text-muted">
											Add Eryn to a server to get started, then connect its OpenCode Go key.
										</p>
									}
								>
									<div class="flex max-w-[820px] flex-col gap-4">
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
			<div class="mt-8 max-w-[820px]">
				<button type="button" class={buttonClass.ghost} onClick={() => setOpen(!open())}>
					{open() ? "Close" : `Add a server (${props.guilds.length})`}
				</button>
				<Show when={open()}>
					<div class="mt-4 divide-y divide-line border border-line">
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
				</Show>
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
				model: String(formData.get("model") ?? ""),
				githubRepo: String(formData.get("github_repo") ?? ""),
			});
			props.onResult("ok", result.message ?? "Saved.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		if (!confirm("Remove the key for this server?")) return;
		setBusy(true);
		try {
			const result = await saveGuild({ action: "remove", guildId: props.guild.id });
			props.onResult("ok", result.message ?? "Removed.");
		} catch (error) {
			props.onResult("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div class="border border-line bg-surface p-6">
			<div class="mb-5 flex items-center gap-3.5">
				<GuildAvatar guild={props.guild} />
				<div class="font-semibold">{props.guild.name}</div>
				<Chip on={props.guild.configured}>{props.guild.configured ? "Configured" : "No key"}</Chip>
			</div>

			<form onSubmit={onSubmit}>
				<label class="mb-3.5 block">
					<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">
						OpenCode Go API key{props.guild.configured ? " — blank keeps current" : ""}
					</span>
					<input
						type="password"
						name="api_key"
						placeholder="sk-…"
						autocomplete="off"
						spellcheck={false}
						class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
					/>
				</label>

				<label class="mb-3.5 block">
					<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Model</span>
					<input
						type="text"
						name="model"
						value={props.guild.model}
						list="models"
						spellcheck={false}
						class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
					/>
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
						{props.guild.configured ? "Update key" : "Save key"}
					</button>
					<Show when={props.guild.configured}>
						<button type="button" class={buttonClass.danger} onClick={() => void onRemove()} disabled={busy()}>
							Remove key
						</button>
					</Show>
				</div>
			</form>
		</div>
	);
}
