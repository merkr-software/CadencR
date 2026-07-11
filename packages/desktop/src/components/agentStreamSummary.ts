import type { AgentBlockData } from "./AgentBlock";
import { isTaskTodoTool, normalizeToolName } from "@/lib/tool-adapter";

/** One row of the tool recap: a (normalized) tool name and how many times it ran. */
export interface ToolSummaryCount {
  name: string;
  count: number;
}

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
  "error",
]);

/** A turn: an optional leading boundary block plus the blocks that follow it. */
interface Segment {
  boundary: AgentBlockData | null;
  body: AgentBlockData[];
}

/** Tools that never render in the stream (todo bookkeeping) are not counted. */
function isCountableTool(block: AgentBlockData): boolean {
  if (block.type !== "tool_call") return false;
  if (block.toolName === "TodoWrite" || isTaskTodoTool(block.toolName)) return false;
  return true;
}

/** Group tool calls by normalized name, preserving first-appearance order. */
function countTools(tools: AgentBlockData[]): ToolSummaryCount[] {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = normalizeToolName(tool.toolName ?? "unknown");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count }));
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
 * Build the recap block. Counts ride on the typed `summaryCounts` field and the
 * turn's intermediate content (every body block except the final message) on
 * `childBlocks` — both in-memory only. The renderer reveals `childBlocks`
 * inline when the recap is expanded, exactly like a Task/Agent block surfaces
 * its subagent steps.
 */
function makeToolSummaryBlock(tools: AgentBlockData[], detail: AgentBlockData[]): AgentBlockData {
  return {
    id: toolSummaryId(tools[0].id),
    type: "tool_summary",
    content: "",
    summaryCounts: countTools(tools),
    childBlocks: detail,
  };
}

/** Split a block list into turns delimited by boundary blocks. */
function splitSegments(blocks: AgentBlockData[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { boundary: null, body: [] };
  for (const block of blocks) {
    if (SEGMENT_BOUNDARY_TYPES.has(block.type)) {
      segments.push(current);
      current = { boundary: block, body: [] };
      continue;
    }
    current.body.push(block);
  }
  segments.push(current);
  return segments;
}

/** The turn's closing message — its last text block, ignoring earlier preamble. */
function findFinalText(body: AgentBlockData[]): AgentBlockData | null {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].type === "text") return body[i];
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

  const tools = segment.body.filter(isCountableTool);
  const finalText = findFinalText(segment.body);
  if (tools.length === 0) {
    // No countable tools — nothing to recap; keep just the closing message.
    if (finalText) result.push(finalText);
    return;
  }

  // Recap header carries the turn's detail (everything but the final message) on
  // `childBlocks`; the renderer reveals it inline via an animated collapsible.
  // The closing message always stays visible below the recap.
  const detail = finalText ? segment.body.filter((block) => block !== finalText) : segment.body;
  result.push(makeToolSummaryBlock(tools, detail));
  if (finalText) result.push(finalText);
}

/**
 * "Summary mode" display transform. Collapses each *finished* turn's tool calls
 * into a single `tool_summary` recap block, followed by only the turn's final
 * text — so the history reads as "user message → recap → final answer". The
 * recap carries the turn's detail on `childBlocks`, which the renderer reveals
 * inline via an animated collapsible (row count is unchanged by expansion). The
 * in-flight turn streams normally and folds to a recap the moment it ends (see
 * `activeStreaming`).
 *
 * Pure function of the current (already root-filtered) block list, so it
 * recomputes cleanly on every batch — including mid-turn steering, where a
 * pinned user message simply starts a fresh segment.
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
