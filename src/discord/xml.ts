/**
 * The small XML dialect Eryn uses to show Discord values to the model.
 *
 * A prompt is a sequence of self-closing references (`<user … />`) followed by
 * text, so the model can tell structure from content. Both the live prompt and
 * the Discord plugin render through here, so there is exactly one escaper.
 */

export type XmlAttributes = readonly (readonly [string, string])[];

/** Escape a value for an XML attribute, so a name containing `&` cannot break the block. */
export function escapeXml(value: string): string {
	return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function attributes(entries: XmlAttributes): string {
	return entries.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ");
}

/** A self-closing reference, such as `<channel id="…" />`. */
export function selfClosing(tag: string, entries: XmlAttributes): string {
	return `<${tag} ${attributes(entries)} />`;
}

/** An element whose body the caller writes, such as `<message id="…">`. */
export function openingTag(tag: string, entries: XmlAttributes): string {
	return `<${tag} ${attributes(entries)}>`;
}
