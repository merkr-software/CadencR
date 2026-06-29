import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import { getArchiveCleanupAvailability } from "@/components/archive-cleanup-availability";
import { WorktreeGroup } from "@/components/WorktreeGroup";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFeatures,
  useIsFeatureEmpty,
  useUpdateFeatureStatus,
  useUpdateFeatureLabel,
  useUpdateFeaturePinned,
  useDeleteFeature,
  useListFeatureWorktrees,
  type Feature,
  type FeatureStatus,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { apiErrorMessage } from "@/lib/api-errors";
import { ProjectFeatureRow } from "@/components/ProjectFeatureRow";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { isInCodeMirrorEditor } from "@/lib/shortcuts/dom-targets";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";
import { partitionActiveFeatures } from "@/lib/feature-grouping";
import { useFeatureActivityCounts } from "@/hooks/useFeatureActivityCounts";
import { useCloseFeatureActivity } from "@/hooks/useCloseFeatureActivity";
import { normalizeLabel, uniqueLabels } from "@/lib/feature-labels";
import {
  deleteFeatureDialogTitle,
  getPendingFeatureArchiveAction,
} from "@/lib/feature-archive-decision";
import {
  adjacentFeature,
  archiveFeatureInCachedLists,
  closeFeatureSession,
  navigateToFeatureOrHome,
  removeFeatureFromCachedLists,
} from "@/components/project-feature-navigation";

const ACTIVE_FEATURE_STATUS: FeatureStatus = "active";
const ARCHIVED_FEATURE_STATUS: FeatureStatus = "archived";

export function ProjectFeatures({
  projectId,
  projectPath,
  activeFeatureId,
  onSelectFeature,
}: {
  projectId: number;
  projectPath: string;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [confirmFeatureId, setConfirmFeatureId] = useState<number | null>(null);
  const [editingLabelFeatureId, setEditingLabelFeatureId] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const { data: features = [] } = useListFeatures({
    project_id: projectId,
    include_archived: true,
  });
  const activeFeatures = useMemo(
    () => features.filter((feature) => feature.status === ACTIVE_FEATURE_STATUS),
    [features],
  );
  const archivedFeatures = useMemo(
    () => features.filter((feature) => feature.status === ARCHIVED_FEATURE_STATUS),
    [features],
  );
  const { data: featureWorktrees = [] } = useListFeatureWorktrees(
    { project_id: projectId },
    { query: { staleTime: 5 * 60 * 1000 } },
  );

  const { worktreeFeatureIds, liveWorktreeFeatureIds } = useMemo(() => {
    const all = new Set<number>();
    const live = new Set<number>();
    for (const w of featureWorktrees) {
      all.add(w.feature_id);
      if (w.live) live.add(w.feature_id);
    }
    return { worktreeFeatureIds: all, liveWorktreeFeatureIds: live };
  }, [featureWorktrees]);
  const { shellCountsByFeatureId, browserCountsByFeatureId } = useFeatureActivityCounts(projectId);

  const worktreeByFeatureId = useMemo(() => {
    const map = new Map<number, FeatureWorktreeInfo>();
    for (const w of featureWorktrees) map.set(w.feature_id, w);
    return map;
  }, [featureWorktrees]);

  // Pinned features are pulled out here so they don't appear in this project's
  // flat list or worktree groups — they render in the global "Pinned" section
  // above the project list (`SidebarPinnedConversations`).
  const { worktreeGroups, flatActiveFeatures } = useMemo(
    () => partitionActiveFeatures(activeFeatures, worktreeByFeatureId, projectPath),
    [activeFeatures, worktreeByFeatureId, projectPath],
  );

  // Live WS-pushed titles from auto-naming. Read raw store slices; derive per-feature inline.
  const wsSessions = useWsSessionStore((s) => s.sessions);

  /** Resolve the live WS title for a feature, or undefined to fall back to HTTP data. */
  const getLiveTitle = (id: number): string | undefined => {
    return wsSessions[wsSessionIdFromFeature(id)]?.featureTitle ?? undefined;
  };

  /** True while auto-naming is running for the given feature. */
  const isAutoNaming = (id: number): boolean => {
    return wsSessions[wsSessionIdFromFeature(id)]?.isAutoNaming ?? false;
  };

  const labelSuggestions = useMemo(() => uniqueLabels(features), [features]);
  const activeFeature = useMemo(
    () => features.find((feature) => feature.id === activeFeatureId),
    [activeFeatureId, features],
  );

  useEffect(() => {
    if (activeFeature?.status === ARCHIVED_FEATURE_STATUS) {
      setShowArchived(true);
    }
  }, [activeFeature?.status]);

  const invalidateFeatures = () => {
    // Catch every feature-scoped cache: list, detail, plan, plan/progress, etc.
    void invalidateByUrlPrefix(queryClient, "/api/features");
  };

  const updateStatusMutation = useUpdateFeatureStatus({
    mutation: {
      onSuccess: (_data, variables) => {
        if (variables.id === activeFeatureId && variables.data.status === ARCHIVED_FEATURE_STATUS) {
          archiveFeatureInCachedLists(queryClient, variables.id);
          closeFeatureSession(variables.id);
          navigateToFeatureOrHome(
            navigate,
            projectId,
            adjacentFeature(activeFeatures, variables.id),
          );
        }
        invalidateFeatures();
      },
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Failed to update feature status"));
      },
    },
  });
  const { mutate: updateFeatureStatus } = updateStatusMutation;

  const deleteMutation = useDeleteFeature({
    mutation: {
      onSuccess: (_data, variables) => {
        const deletedId = variables.id;
        removeFeatureFromCachedLists(queryClient, deletedId);
        closeFeatureSession(deletedId);
        if (deletedId === activeFeatureId) {
          navigateToFeatureOrHome(navigate, projectId, adjacentFeature(activeFeatures, deletedId));
        }
        invalidateFeatures();
      },
    },
  });

  const { mutate: updateFeaturePinned } = useUpdateFeaturePinned({
    mutation: {
      onSuccess: invalidateFeatures,
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Failed to update pinned state"));
      },
    },
  });

  const handleTogglePin = useCallback(
    (featureId: number, pinned: boolean): void => {
      updateFeaturePinned({ id: featureId, data: { pinned } });
    },
    [updateFeaturePinned],
  );

  const updateLabelMutation = useUpdateFeatureLabel({
    mutation: {
      onSuccess: (_data, variables) => {
        setEditingLabelFeatureId(null);
        setLabelDraft("");
        invalidateFeatureQueries(variables.id, ["label"]);
      },
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Failed to update feature label"));
      },
    },
  });

  const handleNavigate = (feature: Feature) => {
    onSelectFeature(feature.id);
    const focusTab = getFocusedTabForFeature(activeFeatureId);
    const wsSessionId = wsSessionIdFromFeature(feature.id);
    void navigate({
      to: "/ws-session/$sessionId",
      params: { sessionId: wsSessionId },
      search: focusTab
        ? { cwd: projectPath, featureId: feature.id, projectId, focusTab }
        : { cwd: projectPath, featureId: feature.id, projectId },
    });
  };

  const handleStartLabelEdit = (feature: Feature): void => {
    setEditingLabelFeatureId(feature.id);
    setLabelDraft(feature.label ?? "");
  };

  const handleActiveFeatureLabelShortcut = useCallback(
    (event: KeyboardEvent): void => {
      if (!activeFeature) return;
      // Mod+Shift+L is also "Select all occurrences" inside the editor
      // buffer. Let the buffer keymap win when focus is in CodeMirror.
      if (isInCodeMirrorEditor(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      handleStartLabelEdit(activeFeature);
    },
    [activeFeature],
  );

  useGlobalShortcutById("edit-label", handleActiveFeatureLabelShortcut, {
    enabled: activeFeature != null,
  });

  const handleSaveLabel = (featureId: number, override?: string): void => {
    const normalized = normalizeLabel(override ?? labelDraft);
    const current = features.find((feature) => feature.id === featureId);
    if (current && normalizeLabel(current.label ?? "") === normalized) {
      setEditingLabelFeatureId(null);
      setLabelDraft("");
      return;
    }
    updateLabelMutation.mutate({
      id: featureId,
      data: { label: normalized },
    });
  };

  const handleUpdateFeatureStatus = useCallback(
    (featureId: number, status: FeatureStatus): void => {
      updateFeatureStatus({
        id: featureId,
        data: { status },
      });
    },
    [updateFeatureStatus],
  );

  const handleUnarchiveFeature = useCallback(
    (featureId: number): void => {
      handleUpdateFeatureStatus(featureId, ACTIVE_FEATURE_STATUS);
    },
    [handleUpdateFeatureStatus],
  );

  // Counts come in from the row (which already has them) so this callback stays
  // referentially stable across the sidebar's 2s activity polling.
  const closeFeatureActivity = useCloseFeatureActivity();
  const handleCloseActivity = useCallback(
    (featureId: number, shellCount: number, browserCount: number): void => {
      closeFeatureActivity({ featureId, shellCount, browserCount });
    },
    [closeFeatureActivity],
  );

  const renderFeature = (feature: Feature) => (
    <ProjectFeatureRow
      key={feature.id}
      feature={feature}
      projectId={projectId}
      activeFeatureId={activeFeatureId}
      liveTitle={getLiveTitle(feature.id)}
      isAutoNaming={isAutoNaming(feature.id)}
      hasWorktree={worktreeFeatureIds.has(feature.id)}
      hasLiveWorktree={liveWorktreeFeatureIds.has(feature.id)}
      shellCount={shellCountsByFeatureId.get(feature.id) ?? 0}
      browserCount={browserCountsByFeatureId[feature.id] ?? 0}
      isEditingLabel={editingLabelFeatureId === feature.id}
      labelDraft={editingLabelFeatureId === feature.id ? labelDraft : ""}
      labelSuggestions={labelSuggestions}
      isSavingLabel={updateLabelMutation.isPending && editingLabelFeatureId === feature.id}
      onNavigate={handleNavigate}
      onStartLabelEdit={handleStartLabelEdit}
      onLabelDraftChange={setLabelDraft}
      onSaveLabel={handleSaveLabel}
      onCancelLabelEdit={() => setEditingLabelFeatureId(null)}
      onArchiveOrDelete={setConfirmFeatureId}
      onUnarchive={handleUnarchiveFeature}
      onTogglePin={handleTogglePin}
      onCloseActivity={handleCloseActivity}
    />
  );

  const confirmFeature = features.find((f) => f.id === confirmFeatureId);
  const isConfirmDelete = confirmFeature?.status === ARCHIVED_FEATURE_STATUS;
  const emptyCheck = useIsFeatureEmpty(confirmFeatureId ?? 0, {
    query: { enabled: confirmFeatureId != null && !isConfirmDelete, refetchOnMount: "always" },
  });
  const confirmAction = getPendingFeatureArchiveAction({
    feature: confirmFeature,
    emptyResponse: emptyCheck.data,
    isCheckingEmpty: emptyCheck.isLoading || emptyCheck.isFetching,
    hasEmptyCheckError: emptyCheck.error != null,
  });
  useEffect(() => {
    if (emptyCheck.error == null || confirmFeatureId == null || isConfirmDelete) return;
    toast.error(apiErrorMessage(emptyCheck.error, "Failed to check whether session is empty"));
  }, [confirmFeatureId, emptyCheck.error, isConfirmDelete]);
  const confirmFeatureWorktree = confirmFeature ? worktreeByFeatureId.get(confirmFeature.id) : null;
  const cleanupAvailability = getArchiveCleanupAvailability(confirmFeatureWorktree);

  return (
    <div className="flex flex-col gap-0.5">
      {worktreeGroups.map((group) => (
        <WorktreeGroup
          key={group.key}
          label={group.label}
          features={group.features}
          renderFeature={renderFeature}
        />
      ))}
      {flatActiveFeatures.map(renderFeature)}

      <ArchiveFeatureDialog
        open={confirmFeatureId != null && confirmAction === "archive"}
        feature={confirmFeature}
        projectId={projectId}
        hasLiveWorktree={cleanupAvailability.hasLiveWorktree}
        showWorktreeRemoval={cleanupAvailability.showWorktreeRemoval}
        showBranchRemoval={cleanupAvailability.showBranchRemoval}
        onOpenChange={(open) => {
          if (!open) setConfirmFeatureId(null);
        }}
        onArchive={(featureId) => {
          handleUpdateFeatureStatus(featureId, ARCHIVED_FEATURE_STATUS);
        }}
      />

      <ConfirmDialog
        open={confirmFeatureId != null && confirmAction === "delete"}
        onOpenChange={(open) => {
          if (!open) setConfirmFeatureId(null);
        }}
        title={deleteFeatureDialogTitle(confirmFeature)}
        description="This cannot be undone."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => {
          if (confirmFeatureId == null) return;
          deleteMutation.mutate({ id: confirmFeatureId });
        }}
      />

      {archivedFeatures.length > 0 && (
        <>
          <button
            type="button"
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowArchived((value) => !value)}
          >
            <span className="flex-1 border-t border-border/50" />
            {showArchived ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            <span className="shrink-0">Archived ({archivedFeatures.length})</span>
            <span className="flex-1 border-t border-border/50" />
          </button>
          {showArchived && (
            <div className="max-h-[calc(5*2.25rem)] overflow-y-auto">
              {archivedFeatures.map(renderFeature)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
