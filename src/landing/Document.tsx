import { HydrationScript } from "@solidjs/web";
import type { JSX } from "@solidjs/web";

import { BRAND, DEFAULT_PUBLIC_ORIGIN } from "../public";
import { analyticsScript } from "./analytics";

const ORIGIN = DEFAULT_PUBLIC_ORIGIN.replace(/\/$/, "");

export default function Document(props: { children: JSX.Element }) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>eryn — your personal agent in Discord</title>
				<meta
					name="description"
					content="Mention @eryn in Discord and it opens a thread, runs the request through an agent, and streams the reply."
				/>
				<meta name="color-scheme" content="dark" />
				<meta name="theme-color" content="#08080a" />
				<link rel="icon" href={BRAND.favicon} sizes="any" />
				<link rel="icon" type="image/png" href={BRAND.icon} sizes="64x64" />
				<link rel="apple-touch-icon" href={BRAND.appleIcon} />
				<meta property="og:type" content="website" />
				<meta property="og:site_name" content="eryn" />
				<meta property="og:title" content="eryn — your personal agent in Discord" />
				<meta
					property="og:description"
					content="Mention @eryn in Discord and it opens a thread, runs the request through an agent, and streams the reply."
				/>
				<meta property="og:url" content={`${ORIGIN}/`} />
				<meta property="og:image" content={`${ORIGIN}${BRAND.banner}`} />
				<meta
					property="og:image:alt"
					content="The Eryn mark: a brushed silver ring around a stylised E"
				/>
				<meta property="og:image:width" content="1600" />
				<meta property="og:image:height" content="564" />
				<meta name="twitter:card" content="summary_large_image" />
				<meta name="twitter:image" content={`${ORIGIN}${BRAND.banner}`} />
				<HydrationScript />
			</head>
			<body>
				{props.children}
				<script innerHTML={analyticsScript()} />
			</body>
		</html>
	);
}
