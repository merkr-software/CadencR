import { useCallback, useMemo, useRef, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { PinIcon } from "lucide-react";
import { toast } from "sonner";
import {
  useListPinnedFeatures,
  useListProjects,
  useUpdateFeaturePinned,
  type Feature,
  type Project,
} from "@/api/generated";
import { PinnedConversationRow } from "@/components/PinnedConversationRow";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Global "Pinned" section rendered above the project list. Pinning is a
 * feature-level concept (`features.is_pinned`), so a single backend query
 * returns every pinned conversation across all projects — each row carries its
 * project color dot so the user can tell them apart at a glance. Renders
 * nothing when no conversation is pinned.
 *
 * Unpinning here and pinning from a project row both write the same column and
 * invalidate the `/api/features` cache prefix (which covers this list); there
 * is no optimistic state — the section re-renders from the refetched data.
 */
export function SidebarPinnedConversations({
  activeFeatureId,
  onSelectFeature,
}: {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}): ReactElement | null {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pinnedFeatures = [] } = useListPinnedFeatures();
  const { data: projects = [] } = useListProjects();

  const projectsById = useMemo(() => {
    const map = new Map<number, Project>();
    for (const project of projects) map.set(project.id, project);
    return map;
  }, [projects]);

  // Keep navigation stable across active-row changes: read the live active id
  // through a ref so the click handler's identity doesn't churn every render.
  const activeFeatureIdRef = useRef(activeFeatureId);
  activeFeatureIdRef.current = activeFeatureId;

  const handleNavigate = useCallback(
    (feature: Feature): void => {
      const project = projectsById.get(feature.project_id);
      if (!project) return;
      onSelectFeature(feature.id);
      const focusTab = getFocusedTabForFeature(activeFeatureIdRef.current);
      void navigate({
        to: "/ws-session/$sessionId",
        params: { sessionId: wsSessionIdFromFeature(feature.id) },
        search: focusTab
          ? { cwd: project.path, featureId: feature.id, projectId: project.id, focusTab }
          : { cwd: project.path, featureId: feature.id, projectId: project.id },
      });
    },
    [navigate, projectsById, onSelectFeature],
  );

  const { mutate: updateFeaturePinned } = useUpdateFeaturePinned({
    mutation: {
      onSuccess: () => void invalidateByUrlPrefix(queryClient, "/api/features"),
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Failed to update pinned state"));
      },
    },
  });

  const handleUnpin = useCallback(
    (featureId: number): void => {
      updateFeaturePinned({ id: featureId, data: { pinned: false } });
    },
    [updateFeaturePinned],
  );

  if (pinnedFeatures.length === 0) return null;

  return (
    <div className="mb-2 flex shrink-0 flex-col gap-0.5 px-1">
      <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        <PinIcon className="size-3 shrink-0" />
        <span>Pinned</span>
      </div>
      {pinnedFeatures.map((feature) => (
        <PinnedConversationRow
          key={feature.id}
          feature={feature}
          activeFeatureId={activeFeatureId}
          onNavigate={handleNavigate}
          onUnpin={handleUnpin}
        />
      ))}
    </div>
  );
}
