/**
 * Telling a Durable Object which deploy is current.
 *
 * A deploy does not restart a live Durable Object: it keeps running the code it
 * started with, and even its `versionMetadata()` binding keeps reporting the
 * deploy it started on. So an object cannot notice a new deploy by itself; the
 * Worker (which always runs the current code) has to say so on every call.
 */

export const DEPLOY_HEADER = "x-eryn-deploy";

/** Where an object remembers the deploy it last saw. */
const DEPLOY_KEY = "deploy:version";

/** How soon after a request a changed deploy restarts the object. */
const RESTART_DELAY_MS = 1_000;

type Versioned = { CF_VERSION?: { id?: string } };

/** The deploy this Worker is serving. */
export function currentDeploy(env: Versioned): string | undefined {
	return env.CF_VERSION?.id;
}

/**
 * Note which deploy a request came from.
 *
 * Returns true when this object has seen a newer deploy and should restart.
 * A first run has no stored version; only a change needs a restart.
 */
async function deployChanged(
	storage: DurableObjectStorage,
	request: Request,
	env: Versioned,
): Promise<boolean> {
	const version = request.headers.get(DEPLOY_HEADER) ?? currentDeploy(env);
	if (!version) return false;
	const stored = await storage.get<string>(DEPLOY_KEY);
	if (stored === version) return false;
	await storage.put(DEPLOY_KEY, version);
	return stored !== undefined;
}

/**
 * Note which deploy a request came from, arming a restart when it changed.
 *
 * Returns true when this object should restart once the request finishes.
 */
export async function deployRestart(
	storage: DurableObjectStorage,
	request: Request,
	env: Versioned,
): Promise<boolean> {
	if (!(await deployChanged(storage, request, env))) return false;
	await storage.setAlarm(Date.now() + RESTART_DELAY_MS);
	return true;
}

/** Request options for a call into a Durable Object, carrying the current deploy. */
export function withDeploy(env: Versioned, init: RequestInit = {}): RequestInit {
	const deploy = currentDeploy(env);
	if (!deploy) return init;
	const headers = new Headers(init.headers);
	headers.set(DEPLOY_HEADER, deploy);
	return { ...init, headers };
}
