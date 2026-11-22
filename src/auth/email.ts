/**
 * Sending the login code.
 *
 * Resend is the default adapter because it has a usable free tier. A deployment
 * that has not configured it still works in development: the code is logged and
 * returned to the caller when the Worker knows it is running locally.
 */

import { log, optional } from "../config.ts";

export interface Mailer {
	/** Whether a real message was sent, rather than logged. */
	send(input: { to: string; code: string }): Promise<{ sent: boolean; error?: string }>;
}

async function postResend(apiKey: string, from: string, to: string, code: string): Promise<Response> {
	return await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			from,
			to: [to],
			subject: `Your Eryn login code: ${code}`,
			text: `Your Eryn login code is ${code}. It expires in 10 minutes.`,
			html: `<p>Your Eryn login code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
		}),
	});
}

/** Build the mailer this deployment can use. */
export function mailer(env: Env): Mailer {
	const apiKey = optional(env, "RESEND_API_KEY");
	const from = (env.EMAIL_FROM as string | undefined) ?? "Eryn <login@eryn.otbeaumont.me>";

	return {
		async send({ to, code }) {
			if (!apiKey) {
				// Never log the code: Worker logs are widely readable, and the code
				// alone is an account.
				log("auth", "RESEND_API_KEY is unset, so no sign-in code was sent");

				return { sent: false };
			}

			try {
				const response = await postResend(apiKey, from, to, code);

				if (response.ok) return { sent: true };
				const body = await response.text().catch(() => "");

				log("auth", `Resend refused the login email: HTTP ${response.status} ${body.slice(0, 200)}`);

				return { sent: false, error: "The login email could not be sent." };
			} catch (error) {
				log("auth", `Resend request failed: ${String(error)}`);

				return { sent: false, error: "The login email could not be sent." };
			}
		},
	};
}
