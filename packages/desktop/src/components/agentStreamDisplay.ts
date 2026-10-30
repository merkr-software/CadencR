import type { AgentBlockData } from "./AgentBlock";
import { rendersStandaloneToolResult, shouldGateFullContent } from "./agent-block-types";
import { collapseTurnsToSummary, isCountableTool } from "./agentStreamSummary";
import {
  isRestartContinuationMessage,
  isRestartInterruptionMarker,
} from "@/lib/agent-message-origin";
import { shouldHideToolCall } from "@/lib/tool-display-policy";

/**
 * A renderable row in the agent stream. In every mode except "compact" each
 * block is its own row. In "compact" mode, each run of consecutive non-text
 * blocks (tool calls, thinking) folds into one `flow` row that renders as a
 * single line until the user unfolds it.
 */
export type DisplayItem =
  | { kind: "block"; key: string; block: AgentBlockData }
  | { kind: "flow"; key: string; blocks: AgentBlockData[] };

/**
 * Only tool calls and thinking fold into a compact line. Prose, prompts, plans,
 * results the renderer shows (Agent/Task output, hidden-tool errors), markers
 * and dividers keep their full row: the mode keeps the conversation itself
 * whole. A truncated wire preview still folds; its line shows the name only.
 */
function isFlowEligible(block: AgentBlockData): boolean {
  if (block.type === "thinking") return true;
  return block.type === "tool_call" && block.toolName !== "ExitPlanMode";
}

/**
 * Whether a folded block draws a compact line. Thinking does; a tool call does
 * unless the full renderer hides it too (runtime plumbing, todo updates the
 * composer's todos instrument owns).
 */
export function hasCompactLine(block: AgentBlockData): boolean {
  return block.type === "thinking" || isCountableTool(block);
}

export function buildDisplayItems(
  blocks: AgentBlockData[],
  options: { compact: boolean },
): DisplayItem[] {
  // Keys must be unique across the whole Virtuoso list — duplicate block ids
  // (e.g. re-prepended history batches) get suffixed deterministically so
  // re-renders stay stable.
  const seenCounts = new Map<string, number>();
  const nextKey = (base: string): string => {
    const seen = seenCounts.get(base) ?? 0;
    seenCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };

  if (!options.compact) {
    return blocks.map((block) => ({ kind: "block", key: nextKey(block.id), block }));
  }
  const items: DisplayItem[] = [];
  let buffer: AgentBlockData[] = [];
  const flushBuffer = (): void => {
    // A run with nothing to draw (todo updates only) would be a zero-height
    // Virtuoso row; its blocks render nothing in this mode anyway.
    if (buffer.some(hasCompactLine)) {
      items.push({ kind: "flow", key: nextKey(`flow:${buffer[0].id}`), blocks: buffer });
    }
    buffer = [];
  };
  for (const block of blocks) {
    if (block.compactFlowBreakBefore) flushBuffer();
    if (isFlowEligible(block)) {
      buffer.push(block);
      continue;
    }
    flushBuffer();
    items.push({ kind: "block", key: nextKey(block.id), block });
  }
  flushBuffer();
  return items;
}

function isHiddenByRenderer(block: AgentBlockData): boolean {
  if (shouldGateFullContent(block)) return false;
  if (block.type === "thinking") return !block.content.trim();
  if (block.type === "tool_call") return shouldHideToolCall(block.toolName);
  if (block.type !== "tool_result") return false;
  return !rendersStandaloneToolResult(block);
}

export function filterRenderableBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  const visible: AgentBlockData[] = [];
  for (const block of blocks) {
    if (isHiddenByRenderer(block)) continue;
    // The resume divider tells the whole story; the marker above it would repeat it.
    const previous = visible.at(-1);
    if (isRestartContinuationMessage(block) && previous && isRestartInterruptionMarker(previous)) {
      visible.pop();
    }
    visible.push(block);
  }
  return visible;
}

export function deriveAgentStreamDisplayBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  return filterRenderableBlocks(blocks.filter((block) => !block.parentToolUseId));
}

/** First visible block only when it could continue a compact run across a prepend seam. */
export function leadingCompactFlowBlock(blocks: AgentBlockData[]): AgentBlockData | undefined {
  for (const block of blocks) {
    if (block.parentToolUseId || isHiddenByRenderer(block)) continue;
    return isFlowEligible(block) ? block : undefined;
  }
  return undefined;
}

/**
 * Which display transforms are active, so row counts match what `AgentStream`
 * actually renders. Both default to off (Maximal, no summary).
 */
export interface DisplayRowMode {
  summaryMode?: boolean;
  compactMode?: boolean;
}

/**
 * Number of Virtuoso rows `AgentStream` renders for `blocks` under the given
 * display mode. Follows the AgentStream pipeline (filter → optional summary
 * collapse → buildDisplayItems) because it drives Virtuoso's `firstItemIndex`
 * prepend anchoring — a mismatch shifts every row key and jumps the scroll on
 * history load. It intentionally omits `activeStreaming`: callers diff two
 * counts (merged − current), so the in-flight tail turn cancels out either way.
 */
export function countRenderableDisplayRows(
  blocks: AgentBlockData[],
  mode?: DisplayRowMode,
): number {
  let display = deriveAgentStreamDisplayBlocks(blocks);
  if (mode?.summaryMode) display = collapseTurnsToSummary(display);
  return buildDisplayItems(display, { compact: !!mode?.compactMode }).length;
}
