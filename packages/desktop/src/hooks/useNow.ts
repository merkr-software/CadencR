import { useEffect, useState } from "react";

/**
 * Delay until `nowMs` next crosses a whole `intervalMs` counted from `anchorMs`,
 * landing just past the boundary so a floored display has already moved.
 */
export function msUntilNextTick(nowMs: number, anchorMs: number, intervalMs: number): number {
  const phase = (((nowMs - anchorMs) % intervalMs) + intervalMs) % intervalMs;
  return intervalMs - phase + 5;
}

/**
 * Wall clock that ticks only while something on screen needs it. With an
 * `anchorMs`, ticks land on that instant's whole intervals — an elapsed timer
 * anchored to a shared (server-stamped) start then flips on every device at
 * once instead of at each one's mount time.
 */
export function useNow(
  active: boolean,
  intervalMs = 1_000,
  anchorMs: number | null = null,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    if (anchorMs == null) {
      const timer = setInterval(() => setNow(Date.now()), intervalMs);
      return () => clearInterval(timer);
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        msUntilNextTick(Date.now(), anchorMs, intervalMs),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, intervalMs, anchorMs]);
  return now;
}
