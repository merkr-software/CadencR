import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { getAgentActivityDigest } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useNow } from "@/hooks/useNow";
import { useNotchPrefs } from "@/lib/notch/notch-prefs";
import {
  aggregateFeatureStatuses,
  composeNotchSnapshot,
  notchTrackedFeatureIds,
  type NotchProviderVisual,
} from "@/lib/notch/notch-snapshot";
import {
  getProviderCatalog,
  subscribeProviderCatalogChanges,
} from "@/lib/provider-catalog-registry";
import { getProviderMetadata } from "@/lib/providers";
import { isBundledIconSrc } from "@/shared/notch";
import { useNotchStore } from "@/stores/notch-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useUnreadStore } from "@/stores/unread-store";
import { useNotchCapabilities, useNotchDestinationActive } from "./useNotchCapabilities";

/** While an agent works, its last action refreshes at this pace. */
const DIGEST_POLL_MS = 2_500;
/** Re-evaluates the "recently finished" window even when nothing else changes. */
const CLOCK_TICK_MS = 60_000;

/**
 * Feeds the macOS notch island. Mounted once at the root; renders nothing.
 *
 * Turns the island on or off with the notification destination, hands it the
 * user's notch settings, and — while it is on — composes snapshots from the
 * session-status store, the unread set and the activity digest, pushing each
 * change to the main process.
 */
export function NotchChannelBridge(): React.JSX.Element | null {
  const capabilities = useNotchCapabilities();
  const enabled = useNotchDestinationActive();
  const prefs = useNotchPrefs();

  useEffect(() => {
    if (!capabilities.data?.supported) return;
    desktopBridge.notchConfigure({ enabled, prefs }).catch((e: unknown) => {
      toast.error(enabled ? "Couldn't open the notch island" : "Couldn't close the notch island", {
        description: apiErrorMessage(e, String(e)),
      });
    });
  }, [capabilities.data?.supported, enabled, prefs]);

  return enabled ? <NotchFeed /> : null;
}

function useProviderVisual(): (
  providerId: string | null | undefined,
) => NotchProviderVisual | null {
  const catalog = useSyncExternalStore(subscribeProviderCatalogChanges, getProviderCatalog);
  return useMemo(
    () => (providerId) => {
      const catalogMeta = providerId ? (catalog.get(providerId) ?? null) : null;
      const meta = getProviderMetadata(providerId, null, "mono", catalogMeta);
      if (!meta) return null;
      const src = meta.iconSrc;
      return {
        label: meta.label,
        iconSrc: src != null && isBundledIconSrc(src) ? src : null,
        mono: meta.isMonochrome,
      };
    },
    [catalog],
  );
}

/** Records every working/blocked → idle transition as a finish, outside React renders. */
function useFinishTracking(): void {
  useEffect(() => {
    let lastBySession = useSessionStatusStore.getState().bySession;
    let previous = aggregateFeatureStatuses(lastBySession);
    return useSessionStatusStore.subscribe((state) => {
      if (state.bySession === lastBySession) return;
      lastBySession = state.bySession;
      const next = aggregateFeatureStatuses(state.bySession);
      const now = Date.now();
      for (const [featureId, before] of previous) {
        const after = next.get(featureId)?.status ?? "idle";
        if (before.status !== "idle" && after === "idle") {
          useNotchStore.getState().markFinished(featureId, now);
        }
      }
      previous = next;
    });
  }, []);
}

function NotchFeed(): null {
  useFinishTracking();
  const bySession = useSessionStatusStore((s) => s.bySession);
  const unread = useUnreadStore((s) => s.byFeature);
  const { finishedAt, dismissedAt } = useNotchStore(
    useShallow((s) => ({ finishedAt: s.finishedAt, dismissedAt: s.dismissedAt })),
  );
  const provider = useProviderVisual();
  const now = useNow(true, CLOCK_TICK_MS);

  useEffect(
    () =>
      desktopBridge.onNotchDismissed(({ featureId }) => {
        useNotchStore.getState().dismiss(featureId, Date.now());
        useUnreadStore.getState().markRead(featureId);
      }),
    [],
  );

  const live = useMemo(() => aggregateFeatureStatuses(bySession), [bySession]);
  const trackedIds = useMemo(
    () => notchTrackedFeatureIds({ live, finishedAt, unread, dismissedAt, now }),
    [live, finishedAt, unread, dismissedAt, now],
  );
  const anyWorking = trackedIds.some((id) => live.get(id)?.status === "agent");
  // A status flip refetches at once so a finished agent shows its final reply.
  // Sorted, so reading a reply (which only reorders the list) refetches nothing.
  const statusKey = trackedIds
    .toSorted((a, b) => a - b)
    .map((id) => `${id}:${live.get(id)?.status ?? "idle"}`)
    .join(",");

  const digest = useQuery({
    queryKey: ["notch", "activity-digest", statusKey],
    queryFn: ({ signal }) => getAgentActivityDigest({ feature_ids: trackedIds.join(",") }, signal),
    enabled: trackedIds.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: anyWorking ? DIGEST_POLL_MS : false,
    // The island matters most while Cadencr itself is in the background.
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!digest.isError) return;
    // One toast while the backend stays down, not one per retry.
    toast.error("Couldn't refresh the notch island", {
      id: "notch-digest-error",
      description: apiErrorMessage(digest.error, String(digest.error)),
    });
  }, [digest.error, digest.isError]);

  const snapshot = useMemo(
    () =>
      composeNotchSnapshot({
        live,
        finishedAt,
        unread,
        dismissedAt,
        digest: digest.data?.entries ?? [],
        provider,
        now,
      }),
    [digest.data, dismissedAt, finishedAt, live, now, provider, unread],
  );

  const lastPushed = useRef<string | null>(null);
  useEffect(() => {
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastPushed.current) return;
    lastPushed.current = serialized;
    desktopBridge.notchPushSnapshot(snapshot).catch((e: unknown) => {
      lastPushed.current = null;
      toast.error("Couldn't update the notch island", {
        id: "notch-push-error",
        description: apiErrorMessage(e, String(e)),
      });
    });
  }, [snapshot]);

  return null;
}
