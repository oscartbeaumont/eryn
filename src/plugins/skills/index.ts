/**
 * Register the guild's Markdown skills with OpenCode.
 *
 * Skills are read from the durable workspace and registered with their real
 * absolute guild-store path. When a skill is activated, its directory is
 * recorded so the file tools can resolve the skill's own relative paths
 * without the model having to spell out `/eryn/...`.
 */

import { Plugin, Skill } from "@opencode/plugin";

import type { Mutable } from '../../mutable.ts';
import type { WorkspaceSkill } from "../../session/workspace-config";

/** Point a session's later file reads at the skill it just activated. */
function activateSkill(
	activeSkills: Map<string, string>,
	directories: ReadonlyMap<string, string>,
	skillId: string,
	sessionID: string,
): void {
	const directory = directories.get(skillId);

	if (directory) activeSkills.set(sessionID, directory);
}

export function workspaceSkillsPlugin(
	skills: readonly WorkspaceSkill[],
	activeSkills?: Map<string, string>,
) {
	if (skills.length === 0) return undefined;

	return Plugin.define({
		id: "eryn.skills",
		async setup(ctx) {
			await ctx.skill.transform((editor) => {
				skills.forEach((skill) => {
					const directory = skill.path.slice(0, skill.path.lastIndexOf("/"));

					const info: Mutable<Skill.Info> = {
						id: Skill.ID.make(skill.id),
						name: Skill.Name.make(skill.name),
						// SAFETY: the workspace stores this skill's absolute path; the
						// `AbsolutePath` brand is only a compile-time marker for it.
						path: skill.path as Skill.Info["path"],
						content: [
							skill.content,
							`Supporting files, if any, live under \`${directory}\`. The \`read\` tool resolves relative paths in this skill against that directory.`,
						].join("\n\n"),
					};

					if (skill.description) info.description = skill.description;

					if (skill.autoinvoke !== undefined) info.autoinvoke = skill.autoinvoke;

					editor.add(Skill.Info.make(info));
				});
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
						activateSkill(activeSkills, directories, String(event.data.id), String(event.data.sessionID));
					}
				} catch {
					// The host closed or replaced the subscription.
				}
			})();

			return () => controller.abort();
		},
	});
}
