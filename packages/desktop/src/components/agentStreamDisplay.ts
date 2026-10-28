import type { AgentBlockData } from "./AgentBlock";
import { shouldGateFullContent } from "./agent-block-types";
import { collapseTurnsToSummary } from "./agentStreamSummary";
import {
  isRestartContinuationMessage,
  isRestartInterruptionMarker,
} from "@/lib/agent-message-origin";
import { shouldHideToolCall } from "@/lib/tool-display-policy";

/**
 * A renderable row in the agent stream. In every mode except "compact" each
 * block is its own row. In "compact" mode, consecutive non-text blocks are
 * folded into bounded `flow` rows so the outer Virtuoso can still window long
 * tool runs while the renderer lays each chunk out as a flex-wrap of tiles.
 */
export type DisplayItem =
  | { kind: "block"; key: string; block: AgentBlockData }
  | { kind: "flow"; key: string; blocks: AgentBlockData[] };

/** Maximum tiles mounted by one compact-flow Virtuoso row. */
export const MAX_COMPACT_FLOW_BLOCKS = 24;

const FLOW_BREAKING_TYPES = new Set<AgentBlockData["type"]>([
  "text",
  "user_message",
  "turn_summary",
  "tool_summary",
  "compact_divider",
  "clear_divider",
  "turn_interrupted",
]);

function isFlowEligible(block: AgentBlockData): boolean {
  if (FLOW_BREAKING_TYPES.has(block.type)) return false;
  // A wire preview is deliberately inert until the user loads the original.
  // Compact tiles parse tool arguments (including patch numstats), so routing a
  // truncated payload through them could present invented or incomplete data.
  if (shouldGateFullContent(block)) return false;
  // Surface Task/Agent results inline as their own row (they own their card
  // chrome); skip the rest, which the renderer hides anyway.
  if (block.type === "tool_result") {
    if (block.isError && shouldHideToolCall(block.sourceToolName)) return false;
    return block.sourceToolName !== "Agent" && block.sourceToolName !== "Task";
  }
  return true;
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
    if (buffer.length === 0) return;
    items.push({ kind: "flow", key: nextKey(`flow:${buffer[0].id}`), blocks: buffer });
    buffer = [];
  };
  for (const block of blocks) {
    if (block.compactFlowBreakBefore) flushBuffer();
    if (isFlowEligible(block)) {
      buffer.push(block);
      if (buffer.length === MAX_COMPACT_FLOW_BLOCKS) flushBuffer();
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
  if (block.isError && shouldHideToolCall(block.sourceToolName)) return false;
  if (block.sourceToolName === "Agent" || block.sourceToolName === "Task") return false;
  return true;
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
