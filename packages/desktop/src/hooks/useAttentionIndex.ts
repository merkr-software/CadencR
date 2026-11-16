import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  buildAttentionIndex,
  liveAttentionIds,
  markedAttentionIds,
  type AttentionEntry,
} from "@/lib/attention-index";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useUnreadStore } from "@/stores/unread-store";

/**
 * Every conversation that needs or deserves a look, across all projects, most
 * urgent first and oldest first within a state. Selects flat id lists, so a
 * streaming agent's repeated status pushes re-render nothing until the set of
 * waiting, working, failed or unread conversations changes.
 */
export function useAttentionIndex(): readonly AttentionEntry[] {
  const waiting = useSessionStatusStore(
    useShallow((state) => liveAttentionIds(state.bySession).waiting),
  );
  const working = useSessionStatusStore(
    useShallow((state) => liveAttentionIds(state.bySession).working),
  );
  const failed = useUnreadStore(
    useShallow(
      (state) =>
        markedAttentionIds(state.failedByFeature, state.byFeature, state.markedOrder).failed,
    ),
  );
  const unread = useUnreadStore(
    useShallow(
      (state) =>
        markedAttentionIds(state.failedByFeature, state.byFeature, state.markedOrder).unread,
    ),
  );
  return useMemo(
    () => buildAttentionIndex({ waiting, working }, { failed, unread }),
    [waiting, working, failed, unread],
  );
}
