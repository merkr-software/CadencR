import { useEffect, useState } from "react";
import { activity as recordActivity } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

const ACTIVITY_INTERVAL_MS = 60 * 60 * 1000;

/** Local foreground activity only; the service deduplicates the monthly audience event. */
export function useTelemetryActivity(enabled: boolean): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastAttempt: number | null = null;
    const record = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (lastAttempt !== null && now - lastAttempt < ACTIVITY_INTERVAL_MS) return;
      lastAttempt = now;
      void recordActivity().then(
        () => {
          if (alive) setError(null);
        },
        (failure: unknown) => {
          if (alive)
            setError(apiErrorMessage(failure, "Could not update the monthly audience counter."));
        },
      );
    };
    record();
    const interval = window.setInterval(record, ACTIVITY_INTERVAL_MS);
    window.addEventListener("focus", record);
    window.addEventListener("pointerdown", record);
    window.addEventListener("keydown", record);
    document.addEventListener("visibilitychange", record);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", record);
      window.removeEventListener("pointerdown", record);
      window.removeEventListener("keydown", record);
      document.removeEventListener("visibilitychange", record);
    };
  }, [enabled]);
  return enabled ? error : null;
}
