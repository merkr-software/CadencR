import type { AgentBlockData } from "./AgentBlock";
import { isTaskTodoTool } from "@/lib/tool-adapter";
import { isSubagentCarrier, shouldHideToolCall } from "@/lib/tool-display-policy";

/** Options controlling how turns collapse into recaps. */
export interface CollapseOptions {
  /**
   * When true, the final (in-flight) turn is left uncollapsed and streams live.
   * The recap is produced only once a turn *ends* — so the user watches the
   * active turn normally and it folds to a recap the moment it finishes.
   */
  activeStreaming?: boolean;
}

/**
 * Block types that end the current turn's tool accumulation. Each starts a new
 * segment: the pending tool recap is flushed, then the boundary block is passed
 * through untouched. `user_message` covers both the initial prompt and any
 * mid-turn steering message — every user input gets its own recap.
 */
const SEGMENT_BOUNDARY_TYPES = new Set<AgentBlockData["type"]>([
  "user_message",
  "turn_summary",
  "compact_divider",
  "clear_divider",
  "turn_interrupted",
  "error",
]);

/**
 * Whether a block closes the current turn and opens a new one. A canonical
 * steer event can be persisted with `promptDeliveryState: "pending_agent"`
 * before the agent receives it, so collapsing the in-flight turn at that
 * moment is wrong. The message becomes a boundary after a received, failed, or
 * terminal-unknown receipt (or when historical delivery was not tracked).
 */
function isSegmentBoundary(block: AgentBlockData): boolean {
  if (block.type === "tool_result" && block.isError) {
    return shouldHideToolCall(block.sourceToolName);
  }
  if (!SEGMENT_BOUNDARY_TYPES.has(block.type)) return false;
  if (
    block.type === "user_message" &&
    block.promptDeliveryState !== undefined &&
    block.promptDeliveryState !== "received_agent"
  ) {
    return false;
  }
  return true;
}

/** A turn: an optional leading boundary block plus the blocks that follow it. */
interface Segment {
  boundary: AgentBlockData | null;
  body: AgentBlockData[];
}

/**
 * Tools that never render in the stream (todo bookkeeping) are not counted.
 * Exported so the recap renderer builds its chips from the same tool set.
 */
export function isCountableTool(block: AgentBlockData): boolean {
  if (block.type !== "tool_call") return false;
  if (block.toolName === "TodoWrite" || isTaskTodoTool(block.toolName)) return false;
  if (shouldHideToolCall(block.toolName)) return false;
  return true;
}

/**
 * Stable synthetic id for a turn's recap block. Anchored on the first tool of
 * the segment so it stays constant while more tools stream in (only its content
 * changes) — Virtuoso keeps the row instead of remounting it mid-turn, and the
 * user's expand toggle survives new chunks.
 */
function toolSummaryId(firstToolId: string): string {
  return `tool-summary-${firstToolId}`;
}

/**
 * Build the recap block. The turn's intermediate content (every body block
 * except the final message) rides on `childBlocks` — in-memory only. The
 * renderer derives the per-tool recap chips from those blocks and reveals them
 * inline when the recap is expanded, exactly like a Task/Agent block surfaces
 * its subagent steps. `tools` only gates whether a recap is worth emitting.
 */
function makeToolSummaryBlock(tools: AgentBlockData[], detail: AgentBlockData[]): AgentBlockData {
  return {
    id: toolSummaryId(tools[0].id),
    type: "tool_summary",
    content: "",
    childBlocks: detail,
  };
}

/** Split a block list into turns delimited by boundary blocks. */
function splitSegments(blocks: AgentBlockData[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { boundary: null, body: [] };
  for (const block of blocks) {
    if (
      block.type === "user_message" &&
      (block.promptDeliveryState === "delivery_failed" ||
        block.promptDeliveryState === "delivery_unknown")
    ) {
      current.body.push(block);
      segments.push(current);
      current = { boundary: null, body: [] };
      continue;
    }
    if (isSegmentBoundary(block)) {
      segments.push(current);
      current = { boundary: block, body: [] };
      continue;
    }
    current.body.push(block);
  }
  segments.push(current);
  return segments;
}

/** Ignore empty stream placeholders, notably the one preceding compaction. */
function findFinalText(body: AgentBlockData[]): AgentBlockData | null {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].type === "text" && body[i].content.trim()) return body[i];
  }
  return null;
}

/** Emit a single segment into `result` under the current collapse options. */
function emitSegment(result: AgentBlockData[], segment: Segment, active: boolean): void {
  if (segment.boundary) result.push(segment.boundary);

  // In-flight turn: render everything live; the recap appears only once it ends.
  if (active) {
    result.push(...segment.body);
    return;
  }

  // Sub-agents stay visible as their own cards: a recap chip would hide who
  // ran, on what, and how it ended.
  const isRecapTool = (block: AgentBlockData): boolean =>
    isCountableTool(block) && !isSubagentCarrier(block);
  const tools = segment.body.filter(isRecapTool);
  const finalText = findFinalText(segment.body);
  const kept = new Set(
    segment.body.filter(
      (block) =>
        block === finalText ||
        isSubagentCarrier(block) ||
        (block.type === "user_message" &&
          block.promptDeliveryState !== undefined &&
          block.promptDeliveryState !== "received_agent"),
    ),
  );
  if (tools.length === 0) {
    // No countable tools — nothing to recap; keep the closing message and
    // whatever must stay visible.
    result.push(...segment.body.filter((block) => kept.has(block)));
    return;
  }

  // Recap header carries the turn's detail (everything not kept visible) on
  // `childBlocks`; the renderer reveals it inline via an animated collapsible.
  // The closing message always stays visible below the recap.
  const summary = makeToolSummaryBlock(
    tools,
    segment.body.filter((block) => !kept.has(block)),
  );
  let emittedSummary = false;
  for (const block of segment.body) {
    if (!emittedSummary && isRecapTool(block)) {
      result.push(summary);
      emittedSummary = true;
    }
    if (kept.has(block)) result.push(block);
  }
}

/**
 * "Summary mode" display transform. Collapses each *finished* turn's tool calls
 * into a single `tool_summary` recap block, followed by only the turn's final
 * text — so the history reads as "user message → recap → final answer". The
 * sub-agents the turn launched keep their cards in place. The
 * recap carries the turn's detail on `childBlocks`, which the renderer reveals
 * inline via an animated collapsible (row count is unchanged by expansion). The
 * in-flight turn streams normally and folds to a recap the moment it ends (see
 * `activeStreaming`).
 *
 * Pure function of the current (already root-filtered) block list, so it
 * recomputes cleanly on every batch — including mid-turn steering, where a
 * pending steer message stays inside the live turn until the agent acknowledges
 * it and only then starts a fresh segment (see `isSegmentBoundary`).
 */
export function collapseTurnsToSummary(
  blocks: AgentBlockData[],
  options: CollapseOptions = {},
): AgentBlockData[] {
  const { activeStreaming = false } = options;
  const segments = splitSegments(blocks);
  const lastIndex = segments.length - 1;
  const result: AgentBlockData[] = [];
  segments.forEach((segment, index) => {
    emitSegment(result, segment, activeStreaming && index === lastIndex);
  });
  return result;
}
