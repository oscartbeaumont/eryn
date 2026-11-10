/**
 * Register the guild's Markdown skills with OpenCode.
 *
 * Skills are read from the durable workspace and registered with their real
 * absolute guild-store path. Supporting files stay on the guild filesystem; the
 * appended note tells the model to read them by absolute path.
 */

import { Plugin, Skill } from "@opencode/plugin";

import type { WorkspaceSkill } from "../../session/workspace-config";

export function workspaceSkillsPlugin(skills: readonly WorkspaceSkill[]) {
	if (skills.length === 0) return undefined;

	return Plugin.define({
		id: "eryn.skills",
		async setup(ctx) {
			await ctx.skill.transform((editor) => {
				for (const skill of skills) {
					const directory = skill.path.slice(0, skill.path.lastIndexOf("/"));
					editor.add(
						Skill.Info.make({
							id: Skill.ID.make(skill.id),
							name: Skill.Name.make(skill.name),
							...(skill.description ? { description: skill.description } : {}),
							...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
							path: skill.path as never,
							content: [
								skill.content,
								`Supporting files, if any, live under \`${directory}\`. Read them by absolute path.`,
							].join("\n\n"),
						}),
					);
				}
			});
		},
	});
}
