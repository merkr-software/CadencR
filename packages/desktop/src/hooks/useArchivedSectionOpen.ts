import { useCallback, useEffect, useState } from "react";
import { SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY, usePersistedIdSet } from "@/hooks/usePersistedIdSet";

/**
 * Whether a project's "Archived" section is open. Explicit toggles are
 * persisted; opening it because the active conversation is archived stays
 * local, so visiting an archived conversation doesn't keep the section open.
 */
export function useArchivedSectionOpen(
  projectId: number,
  activeIsArchived: boolean,
): { showArchived: boolean; toggleArchived: () => void } {
  const { ids, setMember } = usePersistedIdSet(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY);
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => {
    if (activeIsArchived) setAutoOpen(true);
  }, [activeIsArchived]);
  const showArchived = ids.has(projectId) || autoOpen;
  const toggleArchived = useCallback(() => {
    if (showArchived) setAutoOpen(false);
    setMember(projectId, !showArchived);
  }, [projectId, setMember, showArchived]);
  return { showArchived, toggleArchived };
}
