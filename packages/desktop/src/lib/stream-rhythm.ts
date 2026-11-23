/**
 * The agent stream's vertical rhythm (DESIGN.md, "Vertical rhythm"): every two
 * neighbouring rows sit the same visible distance apart, whatever they are, so
 * each row has as much room above as below. Only consecutive work steps stack
 * closer, as one group.
 *
 * The gap between two rows is set once, as padding under the upper one, from
 * both rows' kinds. Hanging it below rather than above keeps rows that are
 * already on screen still when an older history page loads above them: that
 * page arrives with its own spacing complete, and only the live tail row
 * changes when a new row joins it. Gaps are measured between visible pixels:
 * each row's box overhangs its ink by its line height's leading, and
 * `INK_INSET_PX` takes that off.
 */
import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { rendersResultAsProse } from "@/lib/agent-block-content";

/** What a row is, as far as spacing goes. */
type RowFamily = "prompt" | "prose" | "step" | "closing";

/** The running turn's "Working" cursor, which stands where the closing line will. */
type RhythmRow = RowFamily | "cursor";

/** Visible gap between two rows. Hover actions float in it, so it fits their 20px line. */
const ROW_GAP_PX = 24;
/** Visible gap between two consecutive work steps. */
const STEP_GAP_PX = 12;

/** Room above the transcript's first row, constant so a history load moves nothing. */
export const STREAM_TOP_GAP_PX = ROW_GAP_PX;

/** Space between each row's box and its first (top) and last (bottom) visible pixel. */
const INK_INSET_PX: Record<RhythmRow, { top: number; bottom: number }> = {
  prompt: { top: 0, bottom: 0 },
  prose: { top: 2, bottom: 3 },
  step: { top: 4, bottom: 4 },
  closing: { top: 0, bottom: 2 },
  cursor: { top: 0, bottom: 0 },
};

function blockFamily(block: AgentBlockData): RowFamily {
  if (block.type === "user_message") return "prompt";
  if (block.type === "turn_summary") return "closing";
  if (block.type === "text" || rendersResultAsProse(block)) return "prose";
  return "step";
}

function rowFamily(item: DisplayItem): RowFamily {
  if (item.kind === "flow") return "step";
  // A gap row is one line of type with no leading to take off, like a prompt's box.
  return item.kind === "gap" ? "prompt" : blockFamily(item.block);
}

/** Padding between `upper` and `lower` that leaves one visible gap between them. */
function spaceBetween(upper: RhythmRow, lower: RhythmRow): number {
  const gap = upper === "step" && lower === "step" ? STEP_GAP_PX : ROW_GAP_PX;
  return Math.max(0, gap - INK_INSET_PX[upper].bottom - INK_INSET_PX[lower].top);
}

/** Set each row's `spaceBelow` from the row after it; the last row has none yet. */
export function spaceRows(items: DisplayItem[]): DisplayItem[] {
  let below: RowFamily | null = null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    const family = rowFamily(item);
    item.spaceBelow = below === null ? 0 : spaceBetween(family, below);
    below = family;
  }
  return items;
}

/** Padding above the "Working" cursor, under the transcript's last row. */
export function cursorSpaceAbove(lastRow: DisplayItem | undefined): number {
  return lastRow ? spaceBetween(rowFamily(lastRow), "cursor") : 0;
}
