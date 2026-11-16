import type { NotchAgent } from "@/shared/notch";

// Match notch-activity.css: 16px padding, a 16px logo, an 8px margin, and 4px dots + 2px gaps.
const RESERVED_WIDTH = 40;
const DOT_STEP = 6;
const DOT_GAP = 2;
const COUNT_CHARACTER_WIDTH = 4;

function countWidth(extra: number): number {
  return (String(extra).length + 1) * COUNT_CHARACTER_WIDTH;
}

/** Keep the feed's urgent agents first and reserve the complete overflow count before slicing. */
export function activityDots(
  agents: readonly NotchAgent[],
  width: number,
): { shown: readonly NotchAgent[]; extra: number; countWidth: number } {
  const available = Math.max(0, width - RESERVED_WIDTH);
  let visible = Math.min(agents.length, Math.max(0, Math.floor((available + DOT_GAP) / DOT_STEP)));
  if (visible === agents.length) return { shown: agents, extra: 0, countWidth: 0 };
  while (visible > 0 && visible * DOT_STEP + countWidth(agents.length - visible) > available) {
    visible -= 1;
  }
  const extra = agents.length - visible;
  return { shown: agents.slice(0, visible), extra, countWidth: countWidth(extra) };
}
