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
