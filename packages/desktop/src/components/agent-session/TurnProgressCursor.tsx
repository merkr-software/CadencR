import { memo } from "react";
import { useTurnWorkingLabel } from "@/components/TurnWorkingLabel";
import type { TurnClock } from "@/lib/turn-clock";
import { cn } from "@/lib/utils";
import { isTurnInProgress, type TurnLifecycle } from "@/stores/ws-turn-lifecycle";

const StreamingCursor = memo(function StreamingCursor({
  label,
  spaceAbove,
}: {
  label: string;
  spaceAbove: number | undefined;
}) {
  return (
    // No inline padding: the cursor sits on the transcript's left edge. In the
    // transcript it stands where the turn's closing line will, one gap under
    // the last row (`cursorSpaceAbove`).
    <div
      className={cn(
        "flex items-center gap-2 pb-2 text-xs text-primary",
        spaceAbove === undefined && "pt-2",
      )}
      style={spaceAbove === undefined ? undefined : { paddingTop: spaceAbove }}
    >
      <span className="animate-pulse">█</span>
      <span className="font-medium tabular-nums">{label}</span>
    </div>
  );
});

/** The transcript's "working" cursor while a turn is in progress. */
export const TurnProgressCursor = memo(function TurnProgressCursor({
  lifecycle,
  label,
  clock,
  spaceAbove,
}: {
  lifecycle?: TurnLifecycle;
  label: string;
  clock: TurnClock | null;
  /** Padding above the cursor under the transcript's last row; none in an empty one. */
  spaceAbove?: number;
}) {
  // The 1 Hz tick lives here, at the leaf (see `useAgentSessionDisplay`).
  const liveLabel = useTurnWorkingLabel(isTurnInProgress(lifecycle) ? clock : null);
  if (!isTurnInProgress(lifecycle)) return null;
  return <StreamingCursor label={clock ? liveLabel : label} spaceAbove={spaceAbove} />;
});
