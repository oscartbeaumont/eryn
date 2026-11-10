/**
 * Register the guild's Markdown skills with OpenCode.
 *
 * Skills are read from the durable workspace and registered with their real
 * absolute guild-store path. When a skill is activated, its directory is
 * recorded so the file tools can resolve the skill's own relative paths
 * without the model having to spell out `/eryn/...`.
 */

import { Plugin, Skill } from "@opencode/plugin";

import type { WorkspaceSkill } from "../../session/workspace-config";

export function workspaceSkillsPlugin(
	skills: readonly WorkspaceSkill[],
	activeSkills?: Map<string, string>,
) {
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
								`Supporting files, if any, live under \`${directory}\`. The \`read\` tool resolves relative paths in this skill against that directory.`,
							].join("\n\n"),
						}),
					);
				}
			});

			if (!activeSkills) return;
			const directories = new Map(skills.map((skill) => [skill.id, skill.path.slice(0, skill.path.lastIndexOf("/"))]));
			const controller = new AbortController();
			void (async () => {
				try {
					for await (const event of ctx.event.subscribe({
						types: ["session.skill.activated"],
						signal: controller.signal,
					})) {
						const directory = directories.get(String(event.data.id));
						if (directory) activeSkills.set(String(event.data.sessionID), directory);
					}
				} catch {
					// The host closed or replaced the subscription.
				}
			})();
			return () => controller.abort();
		},
	});
}
