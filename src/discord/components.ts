/**
 * The Discord message-component shapes Eryn sends.
 *
 * Only the pieces the setup flow needs are modelled: an action row of buttons
 * or one string select, and the modal built from text inputs. Ids and labels
 * are Discord's; the numbers are Discord's component types.
 */

/** A button. `link` buttons carry a `url`; every other style carries a `custom_id`. */
export interface DiscordButton {
	readonly type: 2;
	/** 1 primary, 2 secondary, 3 success, 4 danger, 5 link. */
	readonly style: 1 | 2 | 3 | 4 | 5;
	readonly label: string;
	readonly custom_id?: string;
	readonly url?: string;
	readonly disabled?: boolean;
}

export interface DiscordSelectOption {
	readonly label: string;
	readonly value: string;
	readonly description?: string;
	readonly default?: boolean;
}

export interface DiscordStringSelect {
	readonly type: 3;
	readonly custom_id: string;
	readonly placeholder?: string;
	readonly options: readonly DiscordSelectOption[];
	readonly min_values?: number;
	readonly max_values?: number;
}

export interface DiscordActionRow {
	readonly type: 1;
	readonly components: readonly (DiscordButton | DiscordStringSelect)[];
}

export type DiscordComponent = DiscordActionRow;

/** One input in a modal. `style` 1 is a single line, 2 a paragraph. */
export interface DiscordTextInput {
	readonly type: 4;
	readonly custom_id: string;
	readonly label: string;
	readonly style: 1 | 2;
	readonly required?: boolean;
	readonly placeholder?: string;
	readonly max_length?: number;
	readonly value?: string;
}

export interface DiscordModal {
	readonly custom_id: string;
	readonly title: string;
	readonly components: readonly {
		readonly type: 1;
		readonly components: readonly DiscordTextInput[];
	}[];
}

/** A row of buttons, the common case. */
export function buttonRow(buttons: readonly DiscordButton[]): DiscordActionRow {
	return { type: 1, components: buttons };
}

/** A single string select wrapped in its own row. */
export function selectRow(select: DiscordStringSelect): DiscordActionRow {
	return { type: 1, components: [select] };
}

/** A link button (style 5): opens a URL and never round-trips to us. */
export function linkButton(label: string, url: string): DiscordButton {
	return { type: 2, style: 5, label: label.slice(0, 80), url };
}

/** A button that comes back as an interaction. */
export function actionButton(
	label: string,
	customId: string,
	style: 1 | 2 | 3 | 4 = 2,
	disabled = false,
): DiscordButton {
	return { type: 2, style, label: label.slice(0, 80), custom_id: customId, disabled };
}
