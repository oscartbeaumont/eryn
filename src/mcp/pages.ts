/** A small browser page for the external MCP sign-in callback. */

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function mcpPage(input: {
	title: string;
	message: string;
	link?: string;
	linkLabel?: string;
	status?: number;
}): Response {
	const link = input.link
		? '<p><a href="' + escapeHtml(input.link) + '">' + escapeHtml(input.linkLabel ?? "Continue") + "</a></p>"
		: "";

	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(input.title)} · Eryn</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #ededed;
       font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; padding: 2rem 1.5rem; }
h1 { margin: 0 0 .75rem; font-size: 1.35rem; letter-spacing: -.02em; }
p { margin: 0 0 .75rem; color: #a1a1aa; }
a { color: #ededed; }
</style>
</head>
<body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${link}</main></body>
</html>`,
		{
			status: input.status ?? 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		},
	);
}
