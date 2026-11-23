import type { DisplayItem, DisplayRowMode, HistoryGap } from "@/types/agent-stream";
import type { AgentBlockData } from "@/types/agent-block";
import {
  rendersStandaloneToolResult,
  rendersToolCall,
  shouldGateFullContent,
} from "@/lib/agent-block-content";
import { collapseTurnsToSummary, isCountableTool } from "@/lib/agent-stream-summary";
import {
  isRestartContinuationMessage,
  isRestartInterruptionMarker,
} from "@/lib/agent-message-origin";
import { isAgentCardCarrier } from "@/lib/spawned-session";
import { spaceRows } from "@/lib/stream-rhythm";
import { blockMessageDbId } from "@/stores/ws-message-identity";
import { NO_HISTORY_GAPS } from "@/stores/ws-history-gaps";

interface GroupOptions {
  compact: boolean;
  /** History not loaded yet: a row of its own, which a compact run never spans. */
  gaps?: readonly HistoryGap[];
}

/**
 * Only tool calls and thinking fold into a compact line. Prose, prompts, plans,
 * sub-agents and spawned conversations (each keeps its own status line), results the renderer shows
 * (Agent/Task output, hidden-tool errors), markers and dividers keep their
 * full row: the mode keeps the conversation itself whole. A truncated wire
 * preview still folds; its line shows the name only.
 */
function isFlowEligible(block: AgentBlockData): boolean {
  if (block.type === "thinking") return true;
  return (
    block.type === "tool_call" && block.toolName !== "ExitPlanMode" && !isAgentCardCarrier(block)
  );
}

/**
 * Whether a folded block draws a compact line. Thinking does; a tool call does
 * unless the full renderer hides it too (runtime plumbing, todo updates the
 * composer's todos instrument owns).
 */
export function hasCompactLine(block: AgentBlockData): boolean {
  return block.type === "thinking" || isCountableTool(block);
}

/**
 * The streaming block's id for a compact run whose newest block it is, else
 * `undefined`. Every other row keeps the same prop while the stream moves on,
 * so their memo holds; the live row learns its head still receives tokens.
 */
export function flowStreamingBlockId(
  blocks: AgentBlockData[],
  streamingBlockId: string | null,
): string | undefined {
  return streamingBlockId !== null && blocks.at(-1)?.id === streamingBlockId
    ? streamingBlockId
    : undefined;
}

/**
 * Key of the row a running turn may still add steps to: the last one. A
 * compact run there keeps its head to one line (see `CompactFlowHead`).
 */
export function liveDisplayItemKey(items: DisplayItem[], turnRunning: boolean): string | null {
  return turnRunning ? (items.at(-1)?.key ?? null) : null;
}

/** The blocks a row renders, in order: none for a history gap. */
export function displayItemBlocks(item: DisplayItem): readonly AgentBlockData[] {
  if (item.kind === "flow") return item.blocks;
  return item.kind === "block" ? [item.block] : [];
}

export function buildDisplayItems(blocks: AgentBlockData[], options: GroupOptions): DisplayItem[] {
  return spaceRows(groupDisplayItems(blocks, options));
}

/**
 * Where a row sits in the session's saved history: its message's database id,
 * or for a summary recap the first step it folds. Null for a live block not
 * persisted yet, which only ever follows every gap.
 */
function historyPosition(block: AgentBlockData): number | null {
  const own = blockMessageDbId(block);
  if (own !== null || block.type !== "tool_summary") return own;
  for (const child of block.childBlocks ?? []) {
    const id = blockMessageDbId(child);
    if (id !== null) return id;
  }
  return null;
}

/**
 * Emits each gap's row ahead of the first block past it. `gaps` comes in
 * database order (the store keeps it so). A gap no loaded block follows has no
 * place in the transcript and is dropped.
 */
function gapCursor(
  gaps: readonly HistoryGap[],
  emit: (item: DisplayItem) => void,
): (block: AgentBlockData) => void {
  let next = 0;
  return (block) => {
    const position = next < gaps.length ? historyPosition(block) : null;
    if (position === null) return;
    while (next < gaps.length && position >= gaps[next].beforeId) {
      const gap = gaps[next];
      emit({ kind: "gap", key: `gap:${gap.id}`, gap });
      next += 1;
    }
  };
}

function groupDisplayItems(blocks: AgentBlockData[], options: GroupOptions): DisplayItem[] {
  // Keys must be unique across the whole Virtuoso list — duplicate block ids
  // (e.g. re-prepended history batches) get suffixed deterministically so
  // re-renders stay stable.
  const seenCounts = new Map<string, number>();
  const nextKey = (base: string): string => {
    const seen = seenCounts.get(base) ?? 0;
    seenCounts.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };

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
  const emitGapsBefore = gapCursor(options.gaps ?? NO_HISTORY_GAPS, (gap) => {
    flushBuffer();
    items.push(gap);
  });
  for (const block of blocks) {
    emitGapsBefore(block);
    if (!options.compact) {
      items.push({ kind: "block", key: nextKey(block.id), block });
      continue;
    }
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
  // A todo update draws nothing (the composer's todos instrument shows it); as
  // a row it would still take a gap in the stream's rhythm.
  if (block.type === "tool_call") return !rendersToolCall(block);
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

/**
 * The first visible block at or past `fromDbId`, only when it could continue a
 * compact run across the seam a history page lands on.
 */
export function compactFlowBlockFrom(
  blocks: AgentBlockData[],
  fromDbId: number,
): AgentBlockData | undefined {
  for (const block of blocks) {
    if (block.parentToolUseId || isHiddenByRenderer(block)) continue;
    const position = historyPosition(block);
    if (position === null || position < fromDbId) continue;
    return isFlowEligible(block) ? block : undefined;
  }
  return undefined;
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
  gaps: readonly HistoryGap[] = NO_HISTORY_GAPS,
): number {
  let display = deriveAgentStreamDisplayBlocks(blocks);
  if (mode?.summaryMode) display = collapseTurnsToSummary(display);
  return groupDisplayItems(display, { compact: !!mode?.compactMode, gaps }).length;
}
