/**
 * The paths of a guild object's internal API.
 *
 * The gateway and the guild object are separate Durable Objects, so this is the
 * one place both sides name a route. Keeping the strings here means a renamed
 * endpoint becomes a type error rather than a 404 at runtime.
 */

export const ROUTES = {
	config: "/config",
	providers: "/providers",
	models: "/models",
	providerConnect: "/provider/connect",
	disconnect: "/disconnect",
	model: "/model",
	links: "/links",
	linkAdd: "/link/add",
	linkRemove: "/link/remove",
	linkProbe: "/link/probe",
	linkTest: "/link/test",
	linkOauthStart: "/link/oauth/start",
	linkOauthStatus: "/link/oauth/status",
	linkOauthUrl: "/link/oauth/url",
	linkOauthComplete: "/link/oauth/complete",
	prompt: "/prompt",
	context: "/context",
	interrupt: "/interrupt",
	compact: "/compact",
	interact: "/interact",
	policy: "/policy",
	policySet: "/policy/set",
	policyClear: "/policy/clear",
	approval: "/approval",
	form: "/form",
	formReply: "/form/reply",
	formCancel: "/form/cancel",
} as const;
