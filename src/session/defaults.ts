/**
 * The files Eryn seeds into a guild's filesystem on first use.
 *
 * They are deliberately ordinary OpenCode files rather than plugin state: the
 * user can ask the agent to edit them, and Eryn rebuilds the host from them on
 * the next turn.
 */

import { CONFIG_PATH, INSTRUCTIONS_PATH, COMMANDS_ROOT, SKILLS_ROOT } from "./locations.ts";

export const SEED_VERSION = 4;

export const DEFAULT_CONFIG_PATH = CONFIG_PATH;
export const DEFAULT_AGENTS_PATH = INSTRUCTIONS_PATH;
export const DEFAULT_DISCORD_SKILL_PATH = `${SKILLS_ROOT}/discord/SKILL.md`;
export const DEFAULT_CONFIG_SKILL_PATH = `${SKILLS_ROOT}/config/SKILL.md`;
export const DEFAULT_EXPLAIN_COMMAND_PATH = `${COMMANDS_ROOT}/explain.md`;

export const DEFAULT_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "build",
  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],
  "websearch": { "provider": "random" },
  "agents": { "title": { "disabled": true } },
  "experimental": { "schedules": true }
}
`;

export const DEFAULT_PROGRESS = `## Progress updates

During long work, send a short update when you start, at each major milestone,
and before any operation that will be quiet for more than a couple of minutes.
Say what changed or what you are waiting on in one sentence. Never narrate
individual tool calls, and short tasks get no progress messages.`;

export const DEFAULT_ATTRIBUTION = `## Attribution

End every GitHub issue, pull request, and comment with this footer:

\`<sub>Generated on _<hostname>_ using _<provider>/<model>_ in _<session>_</sub>\`

Fill it from the \`<session ... />\` element in the system prompt: use its
\`hostname\` for \`<hostname>\`, its \`model\` for \`<provider>/<model>\`, and its
\`id\` for \`<session>\`. Do not guess these values.

A member can ask you to remove this section to stop the attribution.`;

export const DEFAULT_AGENTS = `# Eryn

You are Eryn, an OpenCode agent running inside a Discord server. You are talking
to people in a thread, or in a channel Eryn has been subscribed to.

## Replying

Your own output is not posted to Discord. To answer, call
\`discord_send_message\` with the conversation id from the \`<discord ... />\`
element in the system prompt as \`channelId\`. Use the \`threadId\` when one is
present, otherwise the \`channelId\`.

Keep replies focused. Use tools when they help.

## Asking questions

When you need a choice or a missing detail, call \`discord_ask\` instead of
asking in prose. Pass \`options\` to show them as buttons (up to five) or a select
menu. The tool posts the question and returns immediately: end your turn there.
The answer arrives as a new message and starts the next turn. Use plain text only
when the answer is open-ended and needs a long reply.

${DEFAULT_PROGRESS}

## Discord context

The system prompt carries a \`<discord ... />\` element with the server, channel,
and, in a thread, the thread. Inline \`<@id>\` tokens in user text are Discord
mentions. The \`discord_*\` skill describes the tools available for reading
messages, managing threads, reactions, pins, and message edits.

${DEFAULT_ATTRIBUTION}

## Customising Eryn

Eryn's configuration lives in the guild's filesystem, not in code. You can edit
it when a member asks you to; changes apply on the next request.

The \`Replying\` and \`Progress updates\` sections above are the default voice.
Replace them if the server prefers a different tone or a different amount of
progress reporting.

- \`/eryn/opencode.jsonc\` — OpenCode config for this server.
- \`/eryn/AGENTS.md\` — these instructions.
- \`/eryn/.opencode/skills/<id>/SKILL.md\` — reusable skills.
- \`/eryn/.opencode/commands/<name>.md\` — OpenCode commands.
- \`/eryn/.opencode/agents/<id>.md\` — OpenCode agents.
- \`/workspace\` — the project files you work on.

A member with Manage Server can run \`/eryn reset\` to wipe this filesystem and
restore the seeded defaults.

Use \`read\`, \`write\`, and \`edit\` for paths under \`/eryn\`; the \`bash\` tool only
sees \`/workspace\`. The \`config\` skill explains the file layout and the fields
that are safe to change.
`;

export const DEFAULT_DISCORD_SKILL = `---
name: Discord
description: Use when replying, reading messages, managing threads, or otherwise acting in Discord.
---

# Discord tools

The system prompt names the current server, channel, and thread in a
\`<discord ... />\` element. Use those ids; do not guess them.

## Reading

- \`discord_list_channels\` lists channels in the server.
- \`discord_list_threads\` lists active threads in a channel.
- \`discord_read_messages\` reads recent messages from a channel or thread.

## Replying and threads

- \`discord_ask\` posts a question with optional buttons or a select menu and ends
  your turn. The answer arrives as a new message.
- \`discord_send_message\` posts a reply. Always use this instead of writing a
  reply in your output.
- \`discord_create_thread\` starts a thread from a message.
- \`discord_subscribe_message\` follows a message so a thread started from it
  reaches Eryn.
- \`discord_unsubscribe_message\` stops following one.
- \`discord_join_thread\`, \`discord_leave_thread\`,
  \`discord_archive_thread\`, \`discord_join_channel\`, and
  \`discord_leave_channel\` manage membership.

## Managing messages

- \`discord_react\` adds a reaction.
- \`discord_edit_message\` edits one of Eryn's messages.
- \`discord_delete_message\` deletes an Eryn message.
- \`discord_pin_message\` pins or unpins a message.
`;

export const DEFAULT_EXPLAIN_COMMAND = `---
description: Explain how something works
---

Explain $ARGUMENTS clearly, with concrete examples where they help.
`;

export const DEFAULT_CONFIG_SKILL = `---
name: Eryn configuration
description: Use when a member asks to change Eryn's behaviour, skills, commands, agents, or OpenCode config for this server.
---

# Customising Eryn

Eryn's OpenCode config is a real filesystem in this server's Durable Object.
The agent edits it with the normal file tools, and Eryn rebuilds the host from
it on the next turn.

## Files

- \`/eryn/opencode.jsonc\` — server-wide OpenCode config.
- \`/eryn/AGENTS.md\` — baseline instructions, including the default voice and
  progress-reporting rules.
- \`/eryn/.opencode/skills/<id>/SKILL.md\` — a skill. The directory name is the
  skill id.
- \`/eryn/.opencode/commands/<name>.md\` — a command. Nested paths become names
  with \`/\` separators.
- \`/eryn/.opencode/agents/<id>.md\` — an agent. Frontmatter holds its config
  and the body is its system prompt. \`/eryn/.opencode/agent/<id>.md\` is the
  older primary-agent form.
- \`/workspace\` — the project the agent works on. It is not the config root.

A member with Manage Server can run \`/eryn reset\` to wipe both roots and restore
the seeded defaults.

Use \`read\`, \`write\`, and \`edit\` for \`/eryn\` paths. The \`bash\` tool only sees
\`/workspace\`.

## Safe config fields

The config is JSONC. Preserve unrelated fields when editing it. Useful fields:

- \`default_agent\`
- \`instructions\` (HTTP(S) URLs only; \`/eryn/AGENTS.md\` is always appended)
- \`skills\` (HTTP(S) catalog URLs only; local skills live under
  \`/eryn/.opencode/skills\`)
- \`commands\`
- \`agents\`
- \`permissions\` (the allow-all base is always kept; your rules are appended)
- \`websearch\` (\`{ "provider": "random" }\` uses whichever search integration is
  available; \`false\` disables web search)
- \`experimental.schedules\` (always on)

Do not add \`plugins\`: OpenCode cannot load plugin code at runtime on Workers.
Provider credentials and MCP links are managed by \`/eryn setup\`, not this file.

## Commands

A command is a Markdown prompt template:

\`\`\`md
---
description: Review code for correctness
---

Review $ARGUMENTS. Report bugs first.
\`\`\`

Use \`$ARGUMENTS\` for the whole argument string and \`$1\`, \`$2\`, and so on for
positional arguments. A member runs it with \`/eryn command review <arguments>\`.

An \`!\`...\`\` block runs in the workspace's sandboxed shell before the prompt
is sent, so it can read files under \`/workspace\`.
`;
