import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { UsageMetric } from "@/components/usage/usage-stats-model";

/** What the empty session's usage chart counts: messages sent, or total tokens. */
export type SessionUsageMetric = Extract<UsageMetric, "messages" | "total">;

/**
 * Per-device UI state, like `saved-feature.ts`: which measure the user last
 * picked is not configuration worth syncing through the settings file.
 */
const STORAGE_KEY = "cadencr:session-usage-measure";

function readMetric(): SessionUsageMetric {
  return window.localStorage.getItem(STORAGE_KEY) === "total" ? "total" : "messages";
}

function writeMetric(metric: SessionUsageMetric): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, metric);
  } catch (error) {
    const message = "Could not remember the chart measure. It resets on the next session.";
    console.error(message, error);
    toast.error(message);
  }
}

/** The measure on screen, remembered across sessions on this device. */
export function useSessionUsageMetric(): [SessionUsageMetric, (next: SessionUsageMetric) => void] {
  const [metric, setMetric] = useState(readMetric);
  const update = useCallback((next: SessionUsageMetric) => {
    setMetric(next);
    writeMetric(next);
  }, []);
  return [metric, update];
}
