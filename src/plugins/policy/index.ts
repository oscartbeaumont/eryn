/**
 * The per-principal permission evaluator.
 *
 * OpenCode asks this hook to resolve the effect of every permission check:
 * built-in tools, plugin tools, and external MCP tools. The principal's
 * permissions were resolved by Hub from the message that started the turn;
 * this plugin only reads that result and the session's explicit grants. It
 * never sees Discord or iMessage.
 */

import { Plugin } from "@opencode/plugin";

import { log } from "../../config.ts";
import { describeError } from "../../errors.ts";
import { stringField, toJsonObject } from "../../json.ts";
import { toolDecision, withSessionGrant } from "../../core/policy.ts";
import type { PermissionSet, SessionGrants } from "../../core/policy.ts";

export interface PolicyContext {
	readonly channel: string;
	readonly permissions: PermissionSet;
}

export interface PolicyPluginOptions {
	/** The conversation and resolved permissions for a session. */
	readonly contextFor: (sessionID: string) => Promise<PolicyContext | undefined>;
	/** Grants written by `always` in this session. */
	readonly grantFor: (sessionID: string) => SessionGrants | undefined;
	/** Linked MCP server names, so a tool can be matched to its server. */
	readonly mcpServers: readonly string[];
}

export function policyPlugin(options: PolicyPluginOptions) {
	return Plugin.define({
		id: "eryn.policy",
		async setup(ctx) {
			await ctx.permission.hook("evaluate", async (event) => {
				try {
					const context = await options.contextFor(event.sessionID);

					if (!context) {
						event.effect = "deny";
						event.message = "This session is not attached to a conversation.";

						return;
					}

					const metadata = toJsonObject(event.metadata as never) ?? {};
					const input = toJsonObject(metadata.input) ?? {};
					const requested = stringField(input, "channel") ?? stringField(metadata, "channel");
					const grant = options.grantFor(event.sessionID);
					const permissions = withSessionGrant(context.permissions, grant, event.action);
					const decision = toolDecision(permissions, event.action, {
						mcpServers: options.mcpServers,
						currentChannel: context.channel,
						requestedChannel: requested,
					});

					event.effect = decision === "block" ? "deny" : decision;
					if (decision === "block") event.message = "This tool is not allowed in this conversation.";
					if (decision === "ask") event.message = "This tool needs approval.";
				} catch (error) {
					log("policy", "permission evaluation failed: " + describeError(error));
					event.effect = "deny";
					event.message = "The permission check failed.";
				}
			});
		},
	});
}
