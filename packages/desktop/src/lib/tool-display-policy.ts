import type { AgentBlockData } from "@/components/agent-block-types";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";

export interface SkillPresentation {
  name: string;
  args: string;
}

/**
 * Tools a sub-agent calls to hand its final report back to its parent. The
 * report is shown as the sub-agent's result, not as one of its actions.
 */
export const SUBAGENT_HANDBACK_TOOL_NAMES: ReadonlySet<string> = new Set(["SubagentHandback"]);

/** A dispatch tool that launches a sub-agent; adapters map every provider onto these. */
export function isSubagentToolName(name: string | undefined): boolean {
  return name === "Task" || name === "Agent";
}

/** A tool call that launched a sub-agent (its carrier), whichever provider. */
export function isSubagentCarrier(block: Pick<AgentBlockData, "type" | "toolName">): boolean {
  return block.type === "tool_call" && isSubagentToolName(block.toolName);
}

const INTERNAL_TOOL_NAMES = new Set([
  ...SUBAGENT_HANDBACK_TOOL_NAMES,
  "closeAgent",
  "close_agent",
  "create_goal",
  "followupTask",
  "get_goal",
  "interruptAgent",
  "listAgents",
  "request_user_input",
  "resumeAgent",
  "sendInput",
  "sendMessage",
  "send_input",
  "resume_agent",
  "update_goal",
  "update_plan",
  "wait",
  "wait_agent",
  "write_stdin",
]);

export function shouldHideToolCall(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return (
    INTERNAL_TOOL_NAMES.has(toolName) ||
    toolName.startsWith("collaboration__") ||
    toolName.startsWith("multi_agent_v1__")
  );
}

/**
 * Recognize the self-describing command-action shape used when a runtime reads
 * a skill entrypoint. Other providers' ordinary Read calls do not carry these
 * markers, so they remain untouched until they opt into the same semantics.
 */
export function semanticSkillPresentation(
  toolName: string | undefined,
  toolArgs: string | undefined,
): SkillPresentation | undefined {
  if (toolName !== "Read") return undefined;
  const args = parseToolArgsObject(toolArgs);
  if (!args || args.type !== "read" || typeof args.command !== "string") return undefined;
  const path = stringArg(args, "path", "file_path", "filePath");
  if (!path || !path.endsWith("/SKILL.md") || !path.includes("/skills/")) return undefined;
  const segments = path.split("/");
  const name = segments.at(-2);
  if (!name) return undefined;
  return { name, args: JSON.stringify({ skill: name }) };
}
