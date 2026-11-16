import { useCallback, useEffect, useMemo, useState } from "react";
import { SIDEBAR_EXPANDED_PROJECTS_KEY, usePersistedIdSet } from "@/hooks/usePersistedIdSet";
import { clearProjectAutoExpandSkip, shouldSkipProjectAutoExpand } from "@/lib/project-auto-expand";

interface ProjectExpansion {
  expandedIds: ReadonlySet<number>;
  setExpanded: (projectId: number, expanded: boolean) => void;
}

/**
 * Which sidebar projects are expanded. Explicit toggles are persisted; the
 * active project's auto-expansion stays local to the session, so collapsing it
 * sticks across reloads and merely visiting a project writes nothing.
 *
 * Opening a conversation from the pinned section marks its project (see
 * `@/lib/project-auto-expand`) so the tree stays folded; the marker is cleared
 * when the active project becomes null or changes to another project, so a
 * later ordinary navigation expands it normally.
 */
export function useProjectExpansion(activeProjectId: number | null | undefined): ProjectExpansion {
  const persisted = usePersistedIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY);
  const { setMember } = persisted;
  const [autoExpanded, setAutoExpanded] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => {
    if (activeProjectId == null) {
      clearProjectAutoExpandSkip();
      return;
    }
    if (shouldSkipProjectAutoExpand(activeProjectId)) return;
    clearProjectAutoExpandSkip();
    setAutoExpanded((previous) =>
      previous.has(activeProjectId) ? previous : new Set(previous).add(activeProjectId),
    );
  }, [activeProjectId]);

  const expandedIds = useMemo(
    () => (autoExpanded.size === 0 ? persisted.ids : new Set([...persisted.ids, ...autoExpanded])),
    [autoExpanded, persisted.ids],
  );

  const setExpanded = useCallback(
    (projectId: number, expanded: boolean): void => {
      if (!expanded) {
        setAutoExpanded((previous) => {
          if (!previous.has(projectId)) return previous;
          const next = new Set(previous);
          next.delete(projectId);
          return next;
        });
      }
      setMember(projectId, expanded);
    },
    [setMember],
  );

  return useMemo(() => ({ expandedIds, setExpanded }), [expandedIds, setExpanded]);
}
