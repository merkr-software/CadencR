import { memo, useMemo } from "react";
import { useNow } from "@/hooks/useNow";
import { serverToLocalMs } from "@/lib/server-clock";
import { elapsedTurnClock, formatWorkingLabel, type TurnClock } from "@/lib/turn-clock";

/**
 * "Working - <model> - <elapsed>" for a turn the agent is working on, from the
 * backend's turn clock: the same instant on every device, across reloads and
 * restarts. Ticks only while a clock is given.
 */
export function useTurnWorkingLabel(clock: TurnClock | null): string {
  const anchor = clock ? serverToLocalMs(clock.startedAtMs) : null;
  const nowMs = useNow(clock != null, 1_000, anchor);
  if (!clock) return formatWorkingLabel(null, null);
  return formatWorkingLabel(clock.model, elapsedTurnClock(clock, nowMs).totalMs);
}

/**
 * The working label as a leaf: its 1 Hz tick re-renders this text only, never
 * the session or stream around it.
 */
export const TurnWorkingText = memo(function TurnWorkingText({
  clock,
}: {
  clock: TurnClock | null;
}) {
  return <>{useTurnWorkingLabel(clock)}</>;
});

/**
 * The same clock while its values are unchanged. Snapshots rebuild the clock
 * object on every stream delta; memoized consumers must not see a new one.
 */
export function useStableTurnClock(clock: TurnClock | null | undefined): TurnClock | null {
  const startedAtMs = clock?.startedAtMs;
  const waitingMs = clock?.waitingMs ?? 0;
  const waitingSinceMs = clock?.waitingSinceMs ?? null;
  const model = clock?.model ?? null;
  return useMemo(
    () => (startedAtMs == null ? null : { startedAtMs, waitingMs, waitingSinceMs, model }),
    [startedAtMs, waitingMs, waitingSinceMs, model],
  );
}
