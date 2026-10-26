/**
 * Telling a Durable Object which deploy is current.
 *
 * A deploy does not restart a live Durable Object: it keeps running the code it
 * started with, and even its `versionMetadata()` binding keeps reporting the
 * deploy it started on. So an object cannot notice a new deploy by itself; the
 * Worker (which always runs the current code) has to say so on every call.
 */

export const DEPLOY_HEADER = "x-eryn-deploy";

type Versioned = { CF_VERSION?: { id?: string } };

/** The deploy this Worker is serving. */
export function currentDeploy(env: Versioned): string | undefined {
	return env.CF_VERSION?.id;
}

/** Request options for a call into a Durable Object, carrying the current deploy. */
export function withDeploy(env: Versioned, init: RequestInit = {}): RequestInit {
	const deploy = currentDeploy(env);
	if (!deploy) return init;
	const headers = new Headers(init.headers);
	headers.set(DEPLOY_HEADER, deploy);
	return { ...init, headers };
}
