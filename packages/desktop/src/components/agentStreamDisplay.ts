import type { AgentBlockData } from "./AgentBlock";
import { collapseTurnsToSummary } from "./agentStreamSummary";

/**
 * A renderable row in the agent stream. In every mode except "compact" each
 * block is its own row. In "compact" mode, consecutive non-text blocks are
 * folded into a single `flow` row so the renderer can lay them out as a
 * flex-wrap of tiles between text/user-message rows.
 */
export type DisplayItem =
  | { kind: "block"; key: string; block: AgentBlockData }
  | { kind: "flow"; key: string; blocks: AgentBlockData[] };

const FLOW_BREAKING_TYPES = new Set<AgentBlockData["type"]>([
  "text",
  "user_message",
  "turn_summary",
  "tool_summary",
  "compact_divider",
  "clear_divider",
]);

function isFlowEligible(block: AgentBlockData): boolean {
  if (FLOW_BREAKING_TYPES.has(block.type)) return false;
  // Surface Task/Agent results inline as their own row (they own their card
  // chrome); skip the rest, which the renderer hides anyway.
  if (block.type === "tool_result") {
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
  if (block.type === "thinking") return !block.content.trim();
  if (block.type !== "tool_result") return false;
  if (block.sourceToolName === "Agent" || block.sourceToolName === "Task") return false;
  return true;
}

export function filterRenderableBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  const visible: AgentBlockData[] = [];
  for (const block of blocks) {
    if (isHiddenByRenderer(block)) continue;
    visible.push(block);
  }
  return visible;
}

export function deriveAgentStreamDisplayBlocks(blocks: AgentBlockData[]): AgentBlockData[] {
  return filterRenderableBlocks(blocks.filter((block) => !block.parentToolUseId));
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
