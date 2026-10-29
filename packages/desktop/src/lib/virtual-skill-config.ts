/**
 * The configuration a user pins for a spawning `/cadencr:*` virtual skill in
 * the composer's skill wizard.
 *
 * The choices travel as leading `--key=value` flags right after the command
 * (`/cadencr:review --model=gpt-5 branch`). The backend's expansion
 * (`orchestration_skills/config.rs`) consumes them and tells the agent to pass
 * them to every `project_spawn_session` call, so they stay visible in the
 * transcript and can be typed by hand.
 */
import type { SkillWorktree, VirtualSkillPayload } from "@/api/generated";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";

export interface VirtualSkillConfig {
  /** Provider and model are pinned together, from the one picker selection. */
  target?: { providerId: string; modelId: string };
  thinking?: ThinkingEffortLevel;
  permissionMode?: PermissionMode;
  /** `undefined` keeps the skill's default placement (its first worktree). */
  worktree?: SkillWorktree;
}

export const EMPTY_VIRTUAL_SKILL_CONFIG: VirtualSkillConfig = {};

/** A prompt-leading `/cadencr:<name>` or `$cadencr:<name>`: trigger, then command. */
const SKILL_COMMAND = /^(\s*[/$])(cadencr:[a-z-]+)(?=\s|$)/;

/** The `cadencr:<name>` command a prompt starts with, or null. */
export function virtualSkillCommandOf(text: string): string | null {
  return SKILL_COMMAND.exec(text)?.[2] ?? null;
}

/** A skill gets a wizard only when it has something to configure. */
export function hasVirtualSkillParameters(skill: VirtualSkillPayload): boolean {
  return skill.parameters.agent || skill.parameters.worktrees.length > 1;
}

/** The flags `applyVirtualSkillConfig` writes after the command, in order. */
export function virtualSkillFlags(
  skill: VirtualSkillPayload,
  config: VirtualSkillConfig,
): string[] {
  const flags: string[] = [];
  if (skill.parameters.agent && config.target) {
    flags.push(`--provider=${config.target.providerId}`, `--model=${config.target.modelId}`);
    if (config.thinking) flags.push(`--thinking=${config.thinking}`);
    if (config.permissionMode) flags.push(`--mode=${config.permissionMode}`);
  }
  const defaultWorktree = skill.parameters.worktrees[0];
  if (
    config.worktree &&
    config.worktree !== defaultWorktree &&
    skill.parameters.worktrees.includes(config.worktree)
  ) {
    flags.push(`--worktree=${config.worktree}`);
  }
  return flags;
}

/**
 * The prompt with the pinned configuration written as flags after the skill
 * command. Unchanged when the prompt doesn't invoke `skill` or nothing is
 * pinned. Flags the user typed by hand follow these, and the backend keeps the
 * last occurrence, so a hand-typed flag wins.
 */
export function applyVirtualSkillConfig(
  text: string,
  skill: VirtualSkillPayload,
  config: VirtualSkillConfig,
): string {
  const match = SKILL_COMMAND.exec(text);
  if (!match || match[2] !== skill.command) return text;
  const flags = virtualSkillFlags(skill, config);
  if (flags.length === 0) return text;
  const head = match[0];
  const rest = text.slice(head.length).trimStart();
  return [head, ...flags, ...(rest ? [rest] : [])].join(" ");
}
