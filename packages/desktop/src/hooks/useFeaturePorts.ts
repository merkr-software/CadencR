import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getListFeaturePortsQueryKey,
  useListFeaturePorts,
  type AllocatedPort,
} from "@/api/generated";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { useConnectionStatusStore } from "@/stores/connection-status-store";

/** Stable reference so a row with no ports keeps its memoized props. */
export const NO_PORTS: readonly AllocatedPort[] = [];

/**
 * Each poll costs a machine-wide `lsof` sweep on the backend, so this matches
 * the shell-count badges rather than beating them: a dev server that came up
 * seconds ago is still news. React Query skips the interval while the document
 * is hidden — note that a visible-but-unfocused window keeps polling — and the
 * backend caches each scan, so several clients share one process sweep.
 */
const PORT_POLL_INTERVAL_MS = 10_000;
/**
 * Just under the backend's 5 s scan cache TTL: a focus or mount refetch
 * within 4 s of a scan would only be served that same cached scan.
 */
const PORT_STALE_TIME_MS = 4_000;
/**
 * Failures the backend already backs off from (for 10 s after the scan gives
 * up): retrying sooner would only be answered from that backoff. Anything
 * else (a busy database, a transient read error) gets one quick retry before
 * the user hears of it.
 */
const BACKOFF_ERROR_CODES: ReadonlySet<string> = new Set([
  "PORT_SCAN_TIMEOUT",
  "PORT_SCAN_TOOL_MISSING",
]);

function retryTransientScanFailure(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  return failureCount < 1 && (code === null || !BACKOFF_ERROR_CODES.has(code));
}

/**
 * Ports currently held open by each feature's own terminal and agent processes,
 * keyed by feature id. One shared query serves every project section.
 */
export function useFeaturePorts(): Map<number, readonly AllocatedPort[]> {
  const connected = useConnectionStatusStore((s) => s.status === "connected");
  const lastConnectedAt = useConnectionStatusStore((s) => s.lastConnectedAt);
  const [mountedAt] = useState(Date.now);
  const portsQuery = useListFeaturePorts({
    query: {
      // A late response from a previous connection cannot populate this scan.
      queryKey: [...getListFeaturePortsQueryKey(), lastConnectedAt],
      enabled: connected,
      gcTime: 0,
      staleTime: PORT_STALE_TIME_MS,
      retry: retryTransientScanFailure,
      refetchInterval: PORT_POLL_INTERVAL_MS,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  });

  useEffect(() => {
    if (!portsQuery.error) return;
    toast.error(apiErrorMessage(portsQuery.error, "Failed to detect allocated ports"), {
      id: "sidebar-ports-load-error",
    });
  }, [portsQuery.error]);

  // Query retains its last successful data on errors and while reconnecting.
  // A port badge is a live claim: never revive a previous service's snapshot
  // (the key changes per connection) or a snapshot already stale when this
  // caller mounted, before a fresh scan has confirmed it. A snapshot fresh at
  // mount, or fetched since, stays shown until the next scan replaces it, so
  // a newly mounted sibling section shares it without a mount fetch and
  // without losing its badges once it turns stale.
  // `isSuccess` is false while the latest fetch failed, even with data kept.
  const confirmed =
    connected && portsQuery.isSuccess && portsQuery.dataUpdatedAt + PORT_STALE_TIME_MS > mountedAt;

  return useMemo(() => {
    const byFeatureId = new Map<number, readonly AllocatedPort[]>();
    if (!confirmed) return byFeatureId;
    for (const entry of portsQuery.data ?? []) {
      if (entry.ports.length > 0) byFeatureId.set(entry.feature_id, entry.ports);
    }
    return byFeatureId;
  }, [confirmed, portsQuery.data]);
}
