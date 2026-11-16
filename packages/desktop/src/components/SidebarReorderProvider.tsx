import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { moveConversation } from "@/hooks/useManualConversationOrder";
import { indexReorderGroups } from "@/lib/sidebar-manual-order";
import { SidebarReorderContext, type SidebarReorderScope } from "@/lib/sidebar-reorder-context";

type ReorderGroups = readonly (readonly number[])[];

/**
 * Makes a sidebar list's rows reorderable. `groups` are the sibling sets as
 * displayed (memoize them): a row may only land among its own group's
 * members. Null leaves the rows fixed. The scope value never changes: rows
 * look their group up when a drag or a move shortcut starts, so a list update
 * doesn't re-render every row, and the lookup is only built then.
 */
export function SidebarReorderProvider({
  groups,
  children,
}: {
  groups: ReorderGroups | null;
  children: ReactNode;
}): ReactNode {
  const key = useId();
  const groupsRef = useRef<ReorderGroups>([]);
  useLayoutEffect(() => {
    groupsRef.current = groups ?? [];
  }, [groups]);
  const scope = useMemo<SidebarReorderScope>(() => {
    let indexed: { groups: ReorderGroups; byId: ReadonlyMap<number, readonly number[]> } | null =
      null;
    return {
      key,
      groupOf: (featureId) => {
        if (indexed?.groups !== groupsRef.current) {
          indexed = { groups: groupsRef.current, byId: indexReorderGroups(groupsRef.current) };
        }
        return indexed.byId.get(featureId);
      },
      move: moveConversation,
    };
  }, [key]);
  return (
    <SidebarReorderContext.Provider value={groups ? scope : null}>
      {children}
    </SidebarReorderContext.Provider>
  );
}
