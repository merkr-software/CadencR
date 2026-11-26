import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeatureStatus, type Feature } from "@/api/generated";
import { SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY, usePersistedIdSet } from "@/hooks/usePersistedIdSet";

type ActiveFeatureSummary = Pick<Feature, "id" | "status"> | undefined;

/**
 * Whether a project's "Archived" section is open. Explicit toggles are
 * persisted; opening it because the active conversation is archived stays
 * local, closes again once you leave that conversation, and does not open
 * when the currently open conversation is archived while leaving it.
 */
export function useArchivedSectionOpen(
  projectId: number,
  activeFeature: ActiveFeatureSummary,
): { showArchived: boolean; toggleArchived: () => void } {
  const { ids, setMember } = usePersistedIdSet(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY);
  const [suppressedFeatureId, setSuppressedFeatureId] = useState<number | null>(null);
  const prevFeatureRef = useRef<ActiveFeatureSummary>(activeFeature);
  const latestFeatureRef = useRef<ActiveFeatureSummary>(activeFeature);
  latestFeatureRef.current = activeFeature;

  const activeIsArchived = activeFeature?.status === FeatureStatus.archived;
  const justArchivedActive =
    activeIsArchived &&
    prevFeatureRef.current?.id === activeFeature.id &&
    prevFeatureRef.current.status === FeatureStatus.active;

  useEffect(() => {
    prevFeatureRef.current = activeFeature;
    if (justArchivedActive && activeFeature) {
      setSuppressedFeatureId((prev) => (prev === activeFeature.id ? prev : activeFeature.id));
    } else if (
      suppressedFeatureId !== null &&
      (!activeIsArchived || activeFeature?.id !== suppressedFeatureId)
    ) {
      setSuppressedFeatureId(null);
    }
  }, [activeFeature, activeIsArchived, justArchivedActive, suppressedFeatureId]);

  const autoOpen =
    activeIsArchived && !justArchivedActive && suppressedFeatureId !== activeFeature.id;
  const showArchived = ids.has(projectId) || autoOpen;

  const toggleArchived = useCallback(() => {
    const current = latestFeatureRef.current;
    if (showArchived && current?.status === FeatureStatus.archived) {
      setSuppressedFeatureId((prev) => (prev === current.id ? prev : current.id));
    }
    setMember(projectId, !showArchived);
  }, [projectId, setMember, showArchived]);

  return useMemo(() => ({ showArchived, toggleArchived }), [showArchived, toggleArchived]);
}
