import { useEffect, useMemo, useRef } from "react";
import { holdOrder } from "@/lib/frozen-order";
import type { ResolvedNextAction } from "@/lib/next-actions";

/**
 * "For me" without the reshuffling while the user is mid-gesture: with a quick
 * reply open, or the pointer over the list, answering one request must not
 * make the rows jump under the cursor (an answered conversation changes its
 * action and moves). Frozen, the rows keep their order; they re-sort the
 * moment `frozen` ends.
 */
export function useFrozenActionOrder(
  actions: readonly ResolvedNextAction[],
  frozen: boolean,
): readonly ResolvedNextAction[] {
  // The order last shown: what a freeze starting now has to hold.
  const shownIds = useRef<readonly number[]>([]);
  const shown = useMemo(
    () => (frozen ? holdOrder(actions, shownIds.current, (action) => action.feature.id) : actions),
    [actions, frozen],
  );
  useEffect(() => {
    shownIds.current = shown.map((action) => action.feature.id);
  }, [shown]);
  return shown;
}
