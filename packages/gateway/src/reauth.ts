/**
 * A credential the provider rejected, not a call that failed for another
 * reason.
 *
 * The provider clients throw this when a refresh token is gone or an access
 * token is refused, so the gateway can turn it into the one thing the user can
 * act on — reconnect that provider — instead of leaving a bare HTTP status in
 * the transcript. The gateway adds the console link because the provider
 * clients do not know the deployment's origin.
 */
export class CredentialRejectedError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = "CredentialRejectedError";
	}
}

/** A provider's error body, trimmed to something a transcript can carry. */
export function providerDetail(text: string, limit = 300): string {
	const collapsed = text.replace(/\r/g, "").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

/** Whether a refresh response says the grant itself is gone. */
export function isGrantRejection(text: string): boolean {
	return /invalid_grant|expired or revoked/i.test(text);
}
