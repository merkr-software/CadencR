import type { SlashCommand } from "./slash-command";

/**
 * `/cadencr:side <question>` — Cadencr's "ask on the side" as a virtual skill.
 * Unlike the `/cadencr:*` orchestration skills (expanded into the prompt the
 * agent receives), this one never reaches the agent: the composer routes the
 * question to a new conversation in the same permission mode, so the running
 * agent is neither interrupted nor shown it. It needs no MCP server.
 */
export const SIDE_QUESTION_SKILL: SlashCommand = {
  name: "cadencr:side",
  description: "Ask in a separate conversation — this agent is not interrupted",
  kind: "cadencr",
  argumentHint: "<question>",
  standalone: true,
};

/**
 * The question of a `/cadencr:side …` prompt (also `$cadencr:side`, the skill
 * trigger some providers use), `""` when nothing follows the command, or null
 * when the prompt is not a side question. Only the first token counts.
 */
export function parseSideQuestion(text: string): string | null {
  const match = /^\s*[/$]cadencr:side(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return (match[1] ?? "").trim();
}

/** The session's commands plus the side-question skill, once there is a session to ask about. */
export function withSideQuestionSkill(
  commands: SlashCommand[] | undefined,
  sessionId: number | undefined,
): SlashCommand[] | undefined {
  if (sessionId == null || !commands) return commands;
  if (commands.some((command) => command.name === SIDE_QUESTION_SKILL.name)) return commands;
  return [...commands, SIDE_QUESTION_SKILL];
}
