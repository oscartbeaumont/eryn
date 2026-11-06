/**
 * A one-line account of what an MCP server offers, for a Discord message.
 *
 * Kept apart from the link and OAuth modules so callers that only render the
 * result do not pull the network and credential code into their import graph.
 */

export function describeTools(tools: readonly { name: string }[]): string {
	if (!tools.length) return "It advertises no tools.";
	const shown = tools
		.slice(0, 8)
		.map((tool) => tool.name.slice(0, 40))
		.join(", ");
	return `It offers ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${shown}${tools.length > 8 ? ", …" : ""}.`;
}
