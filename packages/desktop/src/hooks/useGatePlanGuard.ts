import { useEffect } from "react";
import { effectiveGateKind } from "@/components/sidebar-pending-gate";
import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";

/**
 * A plan is read in the conversation, never answered from a quick reply. A
 * plan is only known once its request was fetched, so a quick reply can open
 * on one (the phone's sheet, or a shortcut, with no row to say so): this
 * notices, remembers the request as a plan (the queue and the shortcut skip it
 * from then on) and closes without dismissing it.
 * Returns whether the request is a plan.
 */
export function useGatePlanGuard(featureId: number): boolean {
  const { gate } = useFeaturePendingGate({ featureId, enabled: true });
  const isPlan = gate !== undefined && effectiveGateKind(gate) === "plan";
  const requestId = gate?.request_id;

  useEffect(() => {
    if (!isPlan || !requestId) return;
    const store = usePendingGatePopoverStore.getState();
    store.markPlanRequest(requestId, true);
    if (store.open?.featureId === featureId) store.closeGate();
  }, [isPlan, requestId, featureId]);
  return isPlan;
}
