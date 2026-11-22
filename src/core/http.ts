/** JSON request/response plumbing shared by every internal route. */

import { Option, Schema } from "effect";

import { describeError } from "../errors.ts";

export { json } from "../http.ts";

/** An error body with a status, for a route that refused its input. */
export function failure(message: string, status = 400): Response {
	return Response.json({ error: message }, { status });
}

/** Decode a JSON body against a schema, or return the `400` it deserves. */
export async function body<Shape extends Schema.ConstraintDecoder<unknown>>(
	request: Request,
	schema: Shape,
): Promise<Shape["Type"] | Response> {
	let value: unknown;

	try {
		value = await request.json();
	} catch {
		return failure("The request body is not JSON.");
	}

	const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

	return decoded ?? failure(`Could not read the request: ${describeError(new Error("unexpected shape"))}.`);
}

/** The path after a prefix, or undefined when the request is elsewhere. */
export function pathAfter(request: Request, prefix: string): string | undefined {
	const path = new URL(request.url).pathname;

	return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
