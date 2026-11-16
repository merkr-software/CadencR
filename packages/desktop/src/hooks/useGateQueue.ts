import { useMemo } from "react";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSessionStatusStore } from "@/stores/session-status-store";

/**
 * The conversations whose request a quick reply can answer, following the live "For me" order
 * (plans excluded: they are read in the conversation). A request not yet
 * loaded counts: it is only known to be a plan once it was fetched.
 */
export function useGateQueueIds(): readonly number[] {
  const { actions } = useSidebarAttention();
  const planRequestIds = usePendingGatePopoverStore((state) => state.planRequestIds);
  // One string, so a status change that moves no plan leaves the queue alone.
  const plannedKey = useSessionStatusStore((state) => {
    const planned: number[] = [];
    for (const entry of Object.values(state.bySession)) {
      if (entry.status === "question" && entry.requestId && planRequestIds.has(entry.requestId)) {
        planned.push(entry.featureId);
      }
    }
    return planned.sort((a, b) => a - b).join(",");
  });
  return useMemo(() => {
    const planned = new Set(plannedKey === "" ? [] : plannedKey.split(",").map(Number));
    return actions
      .filter((action) => action.kind === "waiting" && !planned.has(action.feature.id))
      .map((action) => action.feature.id);
  }, [actions, plannedKey]);
}

interface GateQueuePosition {
  /** 1-based place of the open request; 0 when it isn't in the queue. */
  position: number;
  total: number;
  previousId: number | null;
  nextId: number | null;
}

/** Where `featureId` stands in the queue, wrapping at both ends. */
export function gateQueuePosition(queue: readonly number[], featureId: number): GateQueuePosition {
  const index = queue.indexOf(featureId);
  const total = queue.length;
  if (index < 0 || total < 2) {
    return { position: index < 0 ? 0 : index + 1, total, previousId: null, nextId: null };
  }
  return {
    position: index + 1,
    total,
    previousId: queue[(index - 1 + total) % total] ?? null,
    nextId: queue[(index + 1) % total] ?? null,
  };
}
