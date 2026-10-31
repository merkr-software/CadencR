import type { AgentBlockData } from "@/types/agent-block";
import { isCountableTool } from "@/lib/agent-stream-summary";
import { isSubagentCarrier } from "@/lib/tool-display-policy";

/**
 * Blocks that read as a sub-agent "action" in the minimal timeline: tool calls,
 * assistant text, and thinking. Tool results and bookkeeping tools are skipped
 * so each row maps to one model instruction.
 */
export function isSubagentAction(block: AgentBlockData): boolean {
  if (block.type === "text") return block.content.trim().length > 0;
  if (block.type === "thinking") return true;
  return isCountableTool(block);
}

export function selectSubagentActions(blocks: AgentBlockData[]): AgentBlockData[] {
  return blocks.filter(isSubagentAction);
}

/** Tool calls the sub-agent made, counted like the timeline lists them. */
export function countSubagentToolCalls(blocks: readonly AgentBlockData[]): number {
  return blocks.reduce((count, block) => count + (isCountableTool(block) ? 1 : 0), 0);
}

export function isNestedSubagentBlock(block: AgentBlockData): boolean {
  return isSubagentCarrier(block) && block.childBlocks !== undefined;
}

/** Collapse multiline assistant text to a single scannable preview. */
export function truncateSubagentText(content: string, maxLen = 100): string {
  const single = content.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 1)}…`;
}

/** First non-empty source line — still valid markdown for a one-line preview. */
export function firstSubagentMarkdownLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}
