import { useEffect, useReducer } from "react";
import { nextCountdownDelay } from "@/lib/schedules/format";

/**
 * Re-render on a cadence that tightens as `target` nears (see
 * `nextCountdownDelay`), so a countdown an hour out costs one render every 30s
 * rather than one per second, and stops entirely once the instant has passed.
 */
export function useCountdownTick(target: Date | null): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!target) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const delay = nextCountdownDelay(target.getTime() - Date.now());
      if (delay == null) return;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [target]);
}
