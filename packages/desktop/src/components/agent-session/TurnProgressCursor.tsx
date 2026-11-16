import { memo } from "react";
import { useTurnWorkingLabel } from "@/components/TurnWorkingLabel";
import type { TurnClock } from "@/lib/turn-clock";
import { isTurnInProgress, type TurnLifecycle } from "@/stores/ws-turn-lifecycle";

const StreamingCursor = memo(function StreamingCursor({ label }: { label: string }) {
  return (
    // No inline padding: the cursor sits on the transcript's left edge.
    <div className="flex items-center gap-2 py-2 text-xs text-primary">
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
}: {
  lifecycle?: TurnLifecycle;
  label: string;
  clock: TurnClock | null;
}) {
  // The 1 Hz tick lives here, at the leaf (see `useAgentSessionDisplay`).
  const liveLabel = useTurnWorkingLabel(isTurnInProgress(lifecycle) ? clock : null);
  if (!isTurnInProgress(lifecycle)) return null;
  return <StreamingCursor label={clock ? liveLabel : label} />;
});
