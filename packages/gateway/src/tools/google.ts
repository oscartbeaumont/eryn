/**
 * The Google Calendar tools.
 *
 * They act as whichever connected Google account the hosted server assigns, so
 * the same call carries the user's own calendar. The scope requested is the full
 * `calendar` scope, because the write tools need it; the account still shows as
 * read-only in the console when the tools that write are switched off.
 */

const API = "https://www.googleapis.com/calendar/v3";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

/** What a Google account stores, so a request can be made and refreshed. */
export interface GoogleCredential {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

export interface GoogleClient {
	request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export interface GoogleTool {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	run: (client: GoogleClient, args: Record<string, unknown>) => Promise<string>;
}

const stringArg = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const numberArg = (value: unknown, fallback: number): number => {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

/** The calendar a call defaults to: Google's name for the signed-in user's own. */
const DEFAULT_CALENDAR = "primary";

function calendarArg(args: Record<string, unknown>): string {
	return stringArg(args.calendar_id) ?? DEFAULT_CALENDAR;
}

function eventSummary(event: Record<string, unknown>): string {
	const start = event.start as { dateTime?: string; date?: string } | undefined;
	const end = event.end as { dateTime?: string; date?: string } | undefined;
	const when = start?.dateTime ?? start?.date ?? "?";
	const until = end?.dateTime ?? end?.date ?? "?";
	const attendees = Array.isArray(event.attendees)
		? (event.attendees as { email?: string }[]).map((a) => a.email).filter(Boolean)
		: [];
	const lines = [
		`${event.summary ?? "(no title)"} — ${when} → ${until}`,
		`id: ${event.id}`,
		event.location ? `where: ${event.location}` : undefined,
		attendees.length ? `with: ${attendees.join(", ")}` : undefined,
		event.htmlLink ? `link: ${event.htmlLink}` : undefined,
	].filter(Boolean);
	return lines.join("\n");
}

/**
 * A client for one Google account.
 *
 * An access token lasts an hour, so it is refreshed in place and the new token
 * is handed back through `onRefresh` for the caller to persist.
 */
export function googleApi(
	credential: GoogleCredential,
	oauth: { clientId: string; clientSecret: string },
	onRefresh?: (next: { accessToken: string; expiresAt: number }) => void,
): GoogleClient {
	let current = credential;
	async function token(): Promise<string> {
		if (!current.expiresAt || current.expiresAt - 60_000 > Date.now() || !current.refreshToken) return current.accessToken;
		const response = await fetch(OAUTH_TOKEN, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: oauth.clientId,
				client_secret: oauth.clientSecret,
				grant_type: "refresh_token",
				refresh_token: current.refreshToken,
			}),
		});
		if (!response.ok) throw new Error(`Google refused a token refresh (HTTP ${response.status})`);
		const body = (await response.json()) as { access_token: string; expires_in?: number };
		const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1_000;
		current = { ...current, accessToken: body.access_token, expiresAt };
		onRefresh?.({ accessToken: current.accessToken, expiresAt });
		return current.accessToken;
	}

	const client: GoogleClient = {
		async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
			const response = await fetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${await token()}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.status === 204) return undefined as T;
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`Google returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
			}
			return (await response.json()) as T;
		},
	};
	return client;
}

export const GOOGLE_TOOLS: readonly GoogleTool[] = [
	{
		name: "google_calendars",
		title: "List calendars",
		description: "List the calendars this account can see, with their id and whether they are the primary one.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (client) => {
			const body = await client.request<{ items?: Record<string, unknown>[] }>("GET", "/users/me/calendarList");
			const items = body.items ?? [];
			if (!items.length) return "No calendars are visible to this account.";
			return items.map((item) => `${item.summary ?? item.id} (id: ${item.id}${item.primary ? ", primary" : ""})`).join("\n");
		},
	},
	{
		name: "google_events",
		title: "List calendar events",
		description:
			"List events in a time window, ordered by start. `time_min` and `time_max` are RFC 3339 timestamps; both default to a window around now.",
		inputSchema: {
			type: "object",
			properties: {
				calendar_id: { type: "string", description: 'The calendar id. Defaults to "primary".' },
				time_min: { type: "string", description: "Start of the window, RFC 3339." },
				time_max: { type: "string", description: "End of the window, RFC 3339." },
				max_results: { type: "integer", description: "How many events to return, 1-50." },
				query: { type: "string", description: "Free-text search over the events." },
			},
			required: [],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const query = new URLSearchParams({ singleEvents: "true", orderBy: "startTime" });
			query.set("timeMin", stringArg(args.time_min) ?? new Date().toISOString());
			if (stringArg(args.time_max)) query.set("timeMax", stringArg(args.time_max)!);
			query.set("maxResults", String(Math.min(Math.max(numberArg(args.max_results, 25), 1), 50)));
			if (stringArg(args.query)) query.set("q", stringArg(args.query)!);
			const body = await client.request<{ items?: Record<string, unknown>[] }>(
				"GET",
				`/calendars/${encodeURIComponent(calendarArg(args))}/events?${query}`,
			);
			const items = body.items ?? [];
			if (!items.length) return "No events in that window.";
			return items.map(eventSummary).join("\n\n");
		},
	},
	{
		name: "google_event",
		title: "Read one calendar event",
		description: "Read one event in full by its id.",
		inputSchema: {
			type: "object",
			properties: { calendar_id: { type: "string" }, event_id: { type: "string", description: "The event id." } },
			required: ["event_id"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const eventId = stringArg(args.event_id);
			if (!eventId) throw new Error("event_id is required");
			const event = await client.request<Record<string, unknown>>(
				"GET",
				`/calendars/${encodeURIComponent(calendarArg(args))}/events/${encodeURIComponent(eventId)}`,
			);
			const description = typeof event.description === "string" ? `\n\n${event.description}` : "";
			return `${eventSummary(event)}${description}`;
		},
	},
	{
		name: "google_create_event",
		title: "Create a calendar event",
		description:
			"Create an event. `start` and `end` are RFC 3339 timestamps for a timed event, or a `YYYY-MM-DD` date for an all-day one. Attendees are email addresses.",
		inputSchema: {
			type: "object",
			properties: {
				calendar_id: { type: "string" },
				summary: { type: "string", description: "The event title." },
				start: { type: "string", description: "Start, RFC 3339 or YYYY-MM-DD." },
				end: { type: "string", description: "End, RFC 3339 or YYYY-MM-DD." },
				description: { type: "string" },
				location: { type: "string" },
				attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses." },
			},
			required: ["summary", "start", "end"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const summary = stringArg(args.summary);
			const start = stringArg(args.start);
			const end = stringArg(args.end);
			if (!summary || !start || !end) throw new Error("summary, start and end are required");
			const time = (value: string) => (value.length === 10 ? { date: value } : { dateTime: value });
			const event = await client.request<Record<string, unknown>>(
				"POST",
				`/calendars/${encodeURIComponent(calendarArg(args))}/events`,
				{
					summary,
					start: time(start),
					end: time(end),
					...(stringArg(args.description) ? { description: stringArg(args.description) } : {}),
					...(stringArg(args.location) ? { location: stringArg(args.location) } : {}),
					...(Array.isArray(args.attendees)
						? { attendees: (args.attendees as string[]).map((email) => ({ email })) }
						: {}),
				},
			);
			return `Created: ${eventSummary(event)}`;
		},
	},
	{
		name: "google_update_event",
		title: "Update a calendar event",
		description: "Change fields on an existing event. Only the fields given are changed.",
		inputSchema: {
			type: "object",
			properties: {
				calendar_id: { type: "string" },
				event_id: { type: "string" },
				summary: { type: "string" },
				start: { type: "string" },
				end: { type: "string" },
				description: { type: "string" },
				location: { type: "string" },
			},
			required: ["event_id"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const eventId = stringArg(args.event_id);
			if (!eventId) throw new Error("event_id is required");
			const time = (value: string) => (value.length === 10 ? { date: value } : { dateTime: value });
			const patch: Record<string, unknown> = {};
			if (stringArg(args.summary)) patch.summary = stringArg(args.summary);
			if (stringArg(args.description)) patch.description = stringArg(args.description);
			if (stringArg(args.location)) patch.location = stringArg(args.location);
			if (stringArg(args.start)) patch.start = time(stringArg(args.start)!);
			if (stringArg(args.end)) patch.end = time(stringArg(args.end)!);
			if (!Object.keys(patch).length) throw new Error("nothing to change");
			const event = await client.request<Record<string, unknown>>(
				"PATCH",
				`/calendars/${encodeURIComponent(calendarArg(args))}/events/${encodeURIComponent(eventId)}`,
				patch,
			);
			return `Updated: ${eventSummary(event)}`;
		},
	},
	{
		name: "google_delete_event",
		title: "Delete a calendar event",
		description: "Delete an event by its id. This cannot be undone.",
		inputSchema: {
			type: "object",
			properties: { calendar_id: { type: "string" }, event_id: { type: "string" } },
			required: ["event_id"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const eventId = stringArg(args.event_id);
			if (!eventId) throw new Error("event_id is required");
			await client.request<void>(
				"DELETE",
				`/calendars/${encodeURIComponent(calendarArg(args))}/events/${encodeURIComponent(eventId)}`,
			);
			return `Deleted event ${eventId}.`;
		},
	},
	{
		name: "google_freebusy",
		title: "Check free/busy",
		description: "Report busy intervals across one or more calendar ids in a time window.",
		inputSchema: {
			type: "object",
			properties: {
				calendar_ids: { type: "array", items: { type: "string" }, description: 'Calendar ids, e.g. ["primary"].' },
				time_min: { type: "string", description: "Start of the window, RFC 3339." },
				time_max: { type: "string", description: "End of the window, RFC 3339." },
			},
			required: ["calendar_ids", "time_min", "time_max"],
			additionalProperties: false,
		},
		run: async (client, args) => {
			const ids = Array.isArray(args.calendar_ids) ? (args.calendar_ids as string[]) : [];
			const timeMin = stringArg(args.time_min);
			const timeMax = stringArg(args.time_max);
			if (!ids.length || !timeMin || !timeMax) throw new Error("calendar_ids, time_min and time_max are required");
			const body = await client.request<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(
				"POST",
				"/freeBusy",
				{ timeMin, timeMax, items: ids.map((id) => ({ id })) },
			);
			const lines: string[] = [];
			for (const [id, value] of Object.entries(body.calendars ?? {})) {
				const busy = value.busy ?? [];
				lines.push(`${id}: ${busy.length ? busy.map((b) => `${b.start} → ${b.end}`).join(", ") : "free"}`);
			}
			return lines.join("\n") || "No calendars reported.";
		},
	},
];

export function googleTool(name: string): GoogleTool | undefined {
	return GOOGLE_TOOLS.find((tool) => tool.name === name);
}
