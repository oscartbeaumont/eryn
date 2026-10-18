import { createSignal } from "solid-js";
import { identify } from "./analytics";
import { fetchSession, type SessionState } from "./api";

/**
 * The signed-in state, fetched once for the whole app and shared through one
 * signal. Components read it synchronously and render a neutral placeholder
 * until it resolves, so nothing flips from "signed out" to "signed in" on load.
 */
const [session, setSession] = createSignal<SessionState | undefined>(undefined);

void fetchSession()
	.then((state) => {
		setSession(state);
		// Tie analytics to the account, so console usage is attributable.
		if (state.signedIn && state.account) identify(state.account.id, { name: state.account.name });
	})
	.catch(() => setSession({ signedIn: false }));

export { session };
