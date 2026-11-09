import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { getGetFeatureSettingsQueryKey, useSetFeatureSetting } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { LAYOUT_STATE_KEY, serializeCurrentLayoutState } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

const PERSIST_DEBOUNCE_MS = 500;

/** The layout the backend holds for a feature, as far as this hook knows. */
interface ConfirmedLayout {
  featureId: number;
  value: string;
}

/**
 * Persists the current per-feature tab/split layout into `feature_settings`.
 * The first observed state is treated as the hydrated baseline and is not
 * written back immediately, which prevents fallback/default hydration from
 * clobbering a server value before the user changes anything.
 *
 * One rule decides what to write: whenever the shown layout differs from the
 * one the backend last confirmed, it is written once edits pause. A failed or
 * cancelled write leaves that difference in place, so the next change — or
 * Retry — writes the layout then shown.
 */
export function useFeatureLayoutPersistence(
  featureId: number,
  options: { enabled?: boolean } = {},
): void {
  const enabled = options.enabled ?? true;
  const serializedLayout = useFeatureLayoutStore((s) => {
    const state = s.features[featureId];
    return state ? serializeCurrentLayoutState(state) : null;
  });
  const [confirmed, setConfirmed] = useState<ConfirmedLayout | null>(null);
  // Bumped by Retry: re-runs the write without a layout change.
  const [retries, setRetries] = useState(0);
  const retry = useCallback(() => setRetries((count) => count + 1), []);
  const send = useLayoutWrite(featureId, setConfirmed, retry);
  const baseline = confirmed?.featureId === featureId ? confirmed.value : null;

  useEffect((): (() => void) | void => {
    if (!enabled || serializedLayout === null) return;
    if (baseline === null) {
      setConfirmed({ featureId, value: serializedLayout });
      return;
    }
    if (serializedLayout === baseline) return;
    // Layout is a gesture: the panes follow it at once and the write trails.
    const timeoutId = window.setTimeout(() => send(serializedLayout), PERSIST_DEBOUNCE_MS);
    return (): void => window.clearTimeout(timeoutId);
  }, [baseline, enabled, featureId, retries, send, serializedLayout]);
}

/**
 * Sends one layout and records it as confirmed once the backend has it.
 *
 * A failed write keeps the arrangement rather than undoing a split or a move
 * half a second after it was made; the toast says so and offers a retry. An
 * earlier failure superseded by a newer write stays quiet: the newer one
 * carries the whole layout and reports its own outcome.
 */
function useLayoutWrite(
  featureId: number,
  setConfirmed: (confirmed: ConfirmedLayout) => void,
  retry: () => void,
): (value: string) => void {
  const queryClient = useQueryClient();
  const { mutate } = useSetFeatureSetting();
  const sentRef = useRef(0);
  const acceptedRef = useRef(0);

  return useCallback(
    (value: string): void => {
      const seq = ++sentRef.current;
      const toastId = `layout-save-${featureId}`;
      mutate(
        { id: featureId, data: { key: LAYOUT_STATE_KEY, value } },
        {
          onSuccess: (): void => {
            if (seq < acceptedRef.current) return;
            acceptedRef.current = seq;
            toast.dismiss(toastId);
            setConfirmed({ featureId, value });
            void queryClient.invalidateQueries({
              queryKey: getGetFeatureSettingsQueryKey(featureId),
            });
          },
          onError: (err: unknown): void => {
            if (seq !== sentRef.current) return;
            toast.error(`Could not save the layout: ${apiErrorMessage(err, "Unknown error")}`, {
              id: toastId,
              description: "This arrangement is kept until the app restarts.",
              action: { label: "Retry", onClick: retry },
            });
          },
        },
      );
    },
    [featureId, mutate, queryClient, retry, setConfirmed],
  );
}
