import type { ReactElement } from "react";
import type { AttentionState } from "@/lib/sidebar-attention";
import { cn } from "@/lib/utils";

type CountedState = Exclude<AttentionState, "idle">;

const DOT_CLASS: Record<CountedState, string> = {
  waiting: "bg-(--acc-yellow)",
  failed: "bg-(--acc-red)",
  working: "sidebar-status-dot-working bg-blue-500",
  unread: "bg-(--acc-green)",
};

interface UnifiedAgentsCounterPillProps {
  state: CountedState;
  count: number;
}

/** One state's count in the header summary; absent when nothing is in it. */
export function UnifiedAgentsCounterPill({
  state,
  count,
}: UnifiedAgentsCounterPillProps): ReactElement | null {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT_CLASS[state])} />
      <span className="font-semibold text-foreground tabular-nums">{count}</span>
      <span>{state}</span>
    </span>
  );
}
