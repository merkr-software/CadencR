import type { AgentBlockData } from "@/components/agent-block-types";
import type { SubagentView } from "@/lib/subagents/subagent-presentation";
import { extractTaskOutput } from "@/lib/tool-adapter";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { isSubagentToolName, SUBAGENT_HANDBACK_TOOL_NAMES } from "@/lib/tool-display-policy";

const NO_CHILDREN: AgentBlockData[] = [];

/**
 * What the sub-agent did, as its carrier holds it: its child blocks, else the
 * output an older carrier persisted in its own arguments.
 */
export function subagentChildren(
  carrier: Pick<AgentBlockData, "id" | "childBlocks" | "toolArgs"> | undefined,
): AgentBlockData[] {
  if (!carrier) return NO_CHILDREN;
  if (carrier.childBlocks?.length) return carrier.childBlocks;
  const persistedOutput = extractTaskOutput(carrier.toolArgs);
  if (!persistedOutput) return carrier.childBlocks ?? NO_CHILDREN;
  return [{ id: `${carrier.id}-persisted-output`, type: "text", content: persistedOutput }];
}

/** The report to show: none while it runs; its transcript's, else the registry's head. */
export function subagentReportFor(
  view: SubagentView,
  children: readonly AgentBlockData[],
): string | null {
  if (view.status === "running") return null;
  return subagentReport(children) ?? view.resultSummary;
}

/**
 * Claude answers a background launch with a fixed acknowledgement, not the
 * sub-agent's report. Two stable phrases keep a real report that mentions
 * "background" from matching.
 */
export function isBackgroundLaunchAck(content: string): boolean {
  return content.includes("Async agent launched") && content.includes("in the background");
}

/**
 * The sub-agent's final report as its transcript holds it: the message it
 * handed back, else the carrier's result when it is a real report, else the
 * last thing the sub-agent said. A carrier result that only points at the
 * handback is not a report.
 */
export function subagentReport(children: readonly AgentBlockData[]): string | null {
  const handedBack = handbackMessage(children);
  if (handedBack) return handedBack;
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.type !== "tool_result") continue;
    if (!isSubagentToolName(child.sourceToolName)) continue;
    const text = subagentResultText(child.content);
    if (text && !isBackgroundLaunchAck(text) && !isHandbackPointer(text)) return text;
  }
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.type === "text" && child.content.trim()) return child.content.trim();
  }
  return null;
}

function handbackMessage(children: readonly AgentBlockData[]): string | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.type !== "tool_call" || !SUBAGENT_HANDBACK_TOOL_NAMES.has(child.toolName ?? "")) {
      continue;
    }
    const args = parseToolArgsObject(child.toolArgs);
    const message = args ? stringArg(args, "message")?.trim() : undefined;
    if (message) return message;
  }
  return null;
}

/** Claude's carrier result once the report went through a handback call. */
function isHandbackPointer(content: string): boolean {
  return content.includes("SubagentHandback call") && content.includes("not repeated here");
}

/**
 * A sub-agent carrier's tool_result as text: plain, or the text parts of the
 * JSON content array the provider returned.
 */
export function subagentResultText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return trimmed;
    return parsed.map(textPart).filter(Boolean).join("\n").trim();
  } catch {
    // Not JSON after all: a report that happens to start with "[".
    return trimmed;
  }
}

function textPart(part: unknown): string {
  if (!part || typeof part !== "object" || !("text" in part)) return "";
  if (typeof part.text !== "string") return "";
  const type = "type" in part ? part.type : undefined;
  return type === undefined || type === "text" ? part.text : "";
}
