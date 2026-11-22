import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import {
  getListFeaturePortsQueryKey,
  useListFeaturePorts,
  type AllocatedPort,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
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
/** Matches the backend's 5s PortScanCache TTL to avoid redundant refetch bursts. */
const PORT_STALE_TIME_MS = 4_000;

/**
 * Ports currently held open by each feature's own terminal and agent processes,
 * keyed by feature id. One shared query serves every project section.
 */
export function useFeaturePorts(): Map<number, readonly AllocatedPort[]> {
  const connected = useConnectionStatusStore((s) => s.status === "connected");
  const lastConnectedAt = useConnectionStatusStore((s) => s.lastConnectedAt);
  const portsQuery = useListFeaturePorts({
    query: {
      // A late response from a previous connection cannot populate this scan.
      queryKey: [...getListFeaturePortsQueryKey(), lastConnectedAt],
      enabled: connected,
      gcTime: 0,
      staleTime: PORT_STALE_TIME_MS,
      retry: false,
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
  // or a stale cached snapshot before a fresh scan in the current connection
  // has confirmed it, while allowing newly mounted sibling sections to share
  // an already-fresh snapshot without triggering a redundant mount fetch.
  const confirmed =
    connected &&
    !portsQuery.isError &&
    (portsQuery.isFetchedAfterMount || (portsQuery.isSuccess && !portsQuery.isStale));

  return useMemo(() => {
    const byFeatureId = new Map<number, readonly AllocatedPort[]>();
    if (!confirmed) return byFeatureId;
    for (const entry of portsQuery.data ?? []) {
      if (entry.ports.length > 0) byFeatureId.set(entry.feature_id, entry.ports);
    }
    return byFeatureId;
  }, [confirmed, portsQuery.data]);
}
