import { useEffect, useRef } from "react";
import { useGateQueueIds } from "@/hooks/useGateQueue";
import { useOpenGateQuickReply } from "@/hooks/useOpenGateQuickReply";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useFeatureStatus } from "@/stores/session-status-selectors";

/**
 * A request's next gate can follow its answer within moments (stacked gates):
 * the popover waits this long for one before it moves on.
 */
export const GATE_ADVANCE_DELAY_MS = 500;

/** The queue entry after `featureId` in `before`, kept only while it still waits. */
export function nextAfterAnswer(
  before: readonly number[],
  featureId: number,
  now: readonly number[],
): number | null {
  const stillWaiting = now.filter((id) => id !== featureId);
  const at = before.indexOf(featureId);
  for (const id of at < 0 ? [] : before.slice(at + 1)) {
    if (stillWaiting.includes(id)) return id;
  }
  return stillWaiting[0] ?? null;
}

/**
 * Hosts what happens once the open quick reply's request is answered (or
 * gone). One the user opened moves on to the next waiting conversation, so
 * working through several doesn't mean reopening it each time; one that
 * opened by itself, or by hovering, just closes. Runs once for the whole app: rows stop showing
 * the popover the moment their conversation stops waiting, so only a global
 * watcher can carry the open state across.
 */
export function useGateAdvance(): void {
  const open = usePendingGatePopoverStore((state) => state.open);
  const queue = useGateQueueIds();
  const openQuickReply = useOpenGateQuickReply();
  // A display options preview sample has no live status to watch.
  const featureId = open && !open.preview ? open.featureId : null;
  const waiting = useFeatureStatus(featureId).status === "question";
  // The queue as of the last render the open request still waited in.
  const queueWhileWaiting = useRef<readonly number[]>(queue);
  if (waiting) queueWhileWaiting.current = queue;
  const latest = useRef({ queue, openQuickReply });
  latest.current = { queue, openQuickReply };

  useEffect(() => {
    if (featureId == null || waiting) return;
    const timer = setTimeout(() => {
      const store = usePendingGatePopoverStore.getState();
      const current = store.open;
      if (current?.featureId !== featureId || current.preview) return;
      const next =
        current.origin === "user"
          ? nextAfterAnswer(queueWhileWaiting.current, featureId, latest.current.queue)
          : null;
      if (next == null) store.closeGate();
      else latest.current.openQuickReply(next);
    }, GATE_ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [featureId, waiting]);
}
