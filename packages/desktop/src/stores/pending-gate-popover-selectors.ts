import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import {
  useSessionStatusStore,
  type SessionStatusEntry,
  type SessionStatusState,
} from "@/stores/session-status-store";

/**
 * Among the sessions awaiting the user (and `accept`ed, when given), the
 * feature whose pending status event is most recent (`seq`, then `sessionId`
 * as tiebreak).
 */
export function mostRecentPendingFeatureId(
  bySession: SessionStatusState["bySession"],
  accept?: (entry: SessionStatusEntry) => boolean,
): number | null {
  let bestFeatureId: number | null = null;
  let bestSeq = -1;
  let bestSessionId = -1;
  for (const [idKey, entry] of Object.entries(bySession)) {
    if (entry.status !== "question" || (accept && !accept(entry))) continue;
    const sessionId = Number(idKey);
    if (entry.seq > bestSeq || (entry.seq === bestSeq && sessionId > bestSessionId)) {
      bestSeq = entry.seq;
      bestSessionId = sessionId;
      bestFeatureId = entry.featureId;
    }
  }
  return bestFeatureId;
}

/**
 * The feature of the newest pending request. Used so only one sidebar
 * pending-gate popover auto-opens at a time. Requests in `skipRequestIds`
 * (plans, which get no quick reply) don't count, so an older permission or
 * question still opens behind a newer plan.
 */
export function useMostRecentPendingFeatureId(skipRequestIds?: ReadonlySet<string>): number | null {
  return useSessionStatusStore((s) =>
    mostRecentPendingFeatureId(
      s.bySession,
      (entry) => !(entry.requestId && skipRequestIds?.has(entry.requestId)),
    ),
  );
}

/** The conversation whose newest request a quick reply can answer (plans aside). */
export function useNewestQuickReplyFeatureId(): number | null {
  const planRequestIds = usePendingGatePopoverStore((s) => s.planRequestIds);
  return useMostRecentPendingFeatureId(planRequestIds);
}

/** Live pending `request_id` for a feature, if any session is in `question`. */
export function useFeaturePendingRequestId(featureId: number): string | null {
  return useSessionStatusStore((s) => {
    let best: { requestId: string | null; seq: number } | null = null;
    for (const entry of Object.values(s.bySession)) {
      if (entry.featureId !== featureId) continue;
      if (entry.status !== "question") continue;
      if (!best || entry.seq > best.seq) {
        best = { requestId: entry.requestId ?? null, seq: entry.seq };
      }
    }
    return best?.requestId ?? null;
  });
}
