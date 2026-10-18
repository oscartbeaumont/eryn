import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ModelOption } from "./api";

const MAX_VISIBLE = 60;

/**
 * A searchable model picker.
 *
 * It is a plain text input first — so a reference the catalogue does not mention
 * can still be typed, and the form submits whatever is in the box — and a
 * filtered listbox second. Keyboard: ↑/↓ move, Enter picks, Escape closes.
 */
export function ModelSelect(props: {
	name: string;
	value: string;
	models: ModelOption[];
	disabled?: boolean;
	placeholder?: string;
	onInput: (value: string) => void;
}) {
	const [open, setOpen] = createSignal(false);
	// Empty means "show everything"; it only narrows once the user types, so
	// focusing the field does not hide the model that is already selected.
	const [query, setQuery] = createSignal("");
	const [active, setActive] = createSignal(0);
	let blurTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => blurTimer && clearTimeout(blurTimer));

	const matches = createMemo(() => {
		const needle = query().trim().toLowerCase();
		const all = props.models;
		const found = needle
			? all.filter(
					(model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
				)
			: all;
		return found.slice(0, MAX_VISIBLE);
	});

	const listId = `${props.name}-models`;

	function pick(model: ModelOption): void {
		props.onInput(model.id);
		setQuery("");
		setOpen(false);
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			setOpen(false);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!open()) {
				setQuery("");
				setOpen(true);
				return;
			}
			const step = event.key === "ArrowDown" ? 1 : -1;
			const total = matches().length;
			if (total === 0) return;
			setActive((current) => (current + step + total) % total);
			return;
		}
		// Enter inside a form submits; while the list is open it should pick.
		if (event.key === "Enter" && open() && matches().length > 0) {
			event.preventDefault();
			const model = matches()[Math.min(active(), matches().length - 1)];
			if (model) pick(model);
		}
	}

	return (
		<div class="relative">
			<input
				type="text"
				name={props.name}
				value={props.value}
				disabled={props.disabled}
				placeholder={props.placeholder}
				autocomplete="off"
				spellcheck={false}
				role="combobox"
				aria-expanded={open() ? "true" : "false"}
				aria-controls={listId}
				aria-autocomplete="list"
				class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg disabled:cursor-not-allowed disabled:border-line disabled:text-faint"
				onInput={(event) => {
					props.onInput(event.currentTarget.value);
					setQuery(event.currentTarget.value);
					setActive(0);
					setOpen(true);
				}}
				onFocus={() => {
					if (props.disabled) return;
					setQuery("");
					setActive(0);
					setOpen(true);
				}}
				onBlur={() => {
					// Let a click on an option land before closing.
					blurTimer = setTimeout(() => setOpen(false), 120);
				}}
				onKeyDown={onKeyDown}
			/>

			<Show when={open() && !props.disabled}>
				<div
					id={listId}
					role="listbox"
					class="absolute left-0 right-0 top-full z-20 max-h-72 overflow-y-auto border border-line-strong border-t-0 bg-surface"
				>
					<Show
						when={matches().length > 0}
						fallback={
							<p class="px-3 py-3 text-xs text-faint">
								{props.models.length === 0 ? "No models loaded." : "No model matches that search."}
							</p>
						}
					>
						<For each={matches()}>
							{(model, index) => (
								<div
									role="option"
									aria-selected={model.id === props.value ? "true" : "false"}
									class={`flex cursor-pointer items-baseline gap-3 px-3 py-2.5 ${
										index() === active() ? "bg-surface-2" : ""
									}`}
									onMouseDown={(event) => event.preventDefault()}
									onMouseEnter={() => setActive(index())}
									onClick={() => pick(model)}
								>
									<span class="font-mono text-sm text-fg">{model.id}</span>
									<span class="min-w-0 flex-1 truncate text-xs text-muted">{model.name}</span>
									<Show when={!model.enabled}>
										<span class="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">unavailable</span>
									</Show>
								</div>
							)}
						</For>
					</Show>
				</div>
			</Show>
		</div>
	);
}
