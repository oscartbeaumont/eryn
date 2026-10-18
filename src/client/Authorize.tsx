import { createSignal, Show } from "solid-js";
import { decideAuthorization, describeAuthorization, type AuthorizeRequest } from "./api";
import { buttonClass, Footer, Header, Kicker } from "./ui";

/**
 * The consent screen for the MCP authorization server.
 *
 * A harness opens this URL with a standard authorization request; approving it
 * mints a one-time code and sends the browser back to the client's registered
 * redirect URI. The request is re-validated on the server when it is approved,
 * so nothing here is trusted.
 */
export default function Authorize() {
	const query = window.location.search.replace(/^\?/, "");
	const [request, setRequest] = createSignal<AuthorizeRequest>();
	void describeAuthorization(query)
		.then(setRequest)
		.catch(() => setRequest({ ok: false, description: "The authorization request could not be read." }));

	async function decide(approve: boolean) {
		const result = await decideAuthorization({ approve, query }).catch(() => undefined);
		if (result?.redirect) {
			window.location.href = result.redirect;
			return;
		}
		if (result?.description) window.alert(result.description);
	}

	return (
		<>
			<Header />
			<main class="flex-1">
				<section class="mx-auto w-[min(620px,92vw)] py-16">
					<Kicker>Authorize</Kicker>
					<Show when={request()} fallback={<p class="font-mono text-sm text-faint">Checking the request…</p>}>
						{(described) => (
							<Show
								when={described().ok}
								fallback={
									<>
										<h1 class="mb-4 text-3xl font-bold leading-tight tracking-[-0.02em]">
											That request cannot be authorized
										</h1>
										<p class="text-muted">
											{described().description ?? "The authorization request was rejected."}
										</p>
										<p class="mt-4 font-mono text-xs text-faint">error: {described().error ?? "invalid_request"}</p>
									</>
								}
							>
								<h1 class="mb-4 text-3xl font-bold leading-tight tracking-[-0.02em]">
									Authorize {described().client ?? "this client"}?
								</h1>
								<p class="mb-6 text-muted">
									It is asking for access to Eryn's MCP tools, currently the{" "}
									<strong class="font-semibold text-fg">random number generator</strong>. You can revoke it by
									ignoring this page in future.
								</p>
								<div class="mb-8 divide-y divide-line border border-line bg-surface font-mono text-sm">
									<div class="flex justify-between gap-4 px-4 py-3">
										<span class="text-faint">scope</span>
										<span>{described().scope ?? "mcp"}</span>
									</div>
									<div class="flex justify-between gap-4 px-4 py-3">
										<span class="text-faint">resource</span>
										<span class="min-w-0 truncate">{described().resource}</span>
									</div>
								</div>
								<div class="flex flex-wrap gap-3">
									<button type="button" class={buttonClass.primary} onClick={() => void decide(true)}>
										Approve
									</button>
									<button type="button" class={buttonClass.ghost} onClick={() => void decide(false)}>
										Deny
									</button>
								</div>
							</Show>
						)}
					</Show>
				</section>
			</main>
			<Footer />
		</>
	);
}
