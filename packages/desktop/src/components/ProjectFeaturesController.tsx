import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  useListFeatures,
  useListFeatureWorktrees,
  useUpdateFeatureLabel,
  type Feature,
  type FeatureStatus,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { FeatureSubtree, type RenderFeature } from "@/components/FeatureSubtree";
import { ProjectFeatureRow } from "@/components/ProjectFeatureRow";
import { apiErrorMessage } from "@/lib/api-errors";
import { getFocusedTabForFeature, type FeatureNavigateOptions } from "@/lib/feature-focus-handoff";
import { partitionActiveFeatures } from "@/lib/feature-grouping";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import { buildFeatureForest } from "@/lib/feature-hierarchy";
import { normalizeLabel, uniqueLabels } from "@/lib/feature-labels";
import { sortConversations } from "@/lib/sidebar-lens";
import { flattenForestIds, projectReorderGroups } from "@/lib/sidebar-manual-order";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { FEATURE_WORKTREES_STALE_MS } from "@/lib/sidebar-queries";
import type { ProjectFilterMatch } from "@/hooks/useSidebarFilterMatches";
import { isInCodeMirrorEditor } from "@/lib/shortcuts/dom-targets";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useCloseFeatureActivity } from "@/hooks/useCloseFeatureActivity";
import { useFeatureActivityCounts } from "@/hooks/useFeatureActivityCounts";
import { NO_PORTS, useFeaturePorts } from "@/hooks/useFeaturePorts";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import { useLiveFeatureMeta } from "@/hooks/useLiveFeatureMeta";
import { useArchiveFeatureAction } from "@/hooks/useArchiveFeatureAction";
import { useFeatureRowMutations } from "@/hooks/useFeatureRowMutations";
import { useArchivedSectionOpen } from "@/hooks/useArchivedSectionOpen";
import { SIDEBAR_COLLAPSED_SUBTREES_KEY, usePersistedIdSet } from "@/hooks/usePersistedIdSet";
import { useStableFeatureOrder } from "@/hooks/useStableFeatureOrder";
import { useManualConversationOrder } from "@/hooks/useManualConversationOrder";
import { useDormantSplit } from "@/hooks/useDormantSplit";
import { useFeatureArchiveConfirmation } from "@/components/useFeatureArchiveConfirmation";

export const ACTIVE_FEATURE_STATUS: FeatureStatus = "active";
export const ARCHIVED_FEATURE_STATUS: FeatureStatus = "archived";

export interface ProjectFeaturesProps {
  projectId: number;
  projectPath: string;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
  /**
   * Set while the sidebar filter is active: the matching conversation ids, or
   * `null` when the project's name matched and everything shows.
   */
  filterMatch?: ProjectFilterMatch;
}

function useProjectFeaturesData({
  projectId,
  projectPath,
  activeFeatureId,
  filterMatch,
}: ProjectFeaturesProps) {
  const { data: features = [] } = useListFeatures({
    project_id: projectId,
    include_archived: true,
  });
  const { data: featureWorktrees = [] } = useListFeatureWorktrees(
    { project_id: projectId },
    { query: { staleTime: FEATURE_WORKTREES_STALE_MS } },
  );
  const { shellCountsByFeatureId, browserCountsByFeatureId, downloadCountsByFeatureId } =
    useFeatureActivityCounts(projectId);
  const portsByFeatureId = useFeaturePorts();
  const liveMeta = useLiveFeatureMeta();
  const activeFeatures = useStableFeatureOrder(
    useMemo(
      () => features.filter((feature) => feature.status === ACTIVE_FEATURE_STATUS),
      [features],
    ),
  );
  // A quick filter leaves archives out: they are a click away once it clears.
  const isFiltering = filterMatch !== undefined;
  const archivedFeatures = useMemo(
    () =>
      isFiltering ? [] : features.filter((feature) => feature.status === ARCHIVED_FEATURE_STATUS),
    [features, isFiltering],
  );
  const shownFeatures = useSortedShownFeatures(activeFeatures, filterMatch);
  const worktreeData = useMemo(() => {
    const worktreeFeatureIds = new Set<number>();
    const liveWorktreeFeatureIds = new Set<number>();
    const worktreeByFeatureId = new Map<number, FeatureWorktreeInfo>();
    for (const worktree of featureWorktrees) {
      worktreeFeatureIds.add(worktree.feature_id);
      worktreeByFeatureId.set(worktree.feature_id, worktree);
      if (worktree.live) liveWorktreeFeatureIds.add(worktree.feature_id);
    }
    return { worktreeFeatureIds, liveWorktreeFeatureIds, worktreeByFeatureId };
  }, [featureWorktrees]);
  const forest = useMemo(
    () => buildFeatureForest(shownFeatures.filter((feature) => !feature.is_pinned)),
    [shownFeatures],
  );
  const { awake: activeForest, dormant } = useDormantSplit(forest, activeFeatureId, isFiltering);
  const dormantFeatures = useMemo(() => dormant.map((node) => node.feature), [dormant]);
  const orderedIds = useMemo(() => flattenForestIds(forest), [forest]);
  const rootNodeByFeatureId = useMemo(
    () => new Map(forest.map((node) => [node.feature.id, node])),
    [forest],
  );
  const groupedFeatures = useMemo(
    () =>
      partitionActiveFeatures(
        activeForest.map((node) => node.feature),
        worktreeData.worktreeByFeatureId,
        projectPath,
      ),
    [activeForest, projectPath, worktreeData.worktreeByFeatureId],
  );
  const reorderGroups = useMemo(
    () => projectReorderGroups(groupedFeatures, dormantFeatures, forest),
    [dormantFeatures, forest, groupedFeatures],
  );
  const getLiveTitle = useCallback(
    (id: number): string | undefined =>
      liveMeta[wsSessionIdFromFeature(id)]?.featureTitle ?? undefined,
    [liveMeta],
  );
  const isAutoNaming = useCallback(
    (id: number): boolean => liveMeta[wsSessionIdFromFeature(id)]?.isAutoNaming ?? false,
    [liveMeta],
  );
  const labelSuggestions = useMemo(() => uniqueLabels(features), [features]);
  return {
    ...groupedFeatures,
    ...worktreeData,
    activeFeature: features.find((feature) => feature.id === activeFeatureId),
    activeFeatures,
    archivedFeatures,
    browserCountsByFeatureId,
    dormantFeatures,
    downloadCountsByFeatureId,
    features,
    getLiveTitle,
    isAutoNaming,
    labelSuggestions,
    orderedIds,
    portsByFeatureId,
    reorderGroups,
    rootNodeByFeatureId,
    shellCountsByFeatureId,
    shownFeatures,
  };
}

type ProjectFeaturesData = ReturnType<typeof useProjectFeaturesData>;

/** The active conversations the tree shows: the filter's matches, in the chosen sort. */
function useSortedShownFeatures(
  activeFeatures: readonly Feature[],
  filterMatch: ProjectFilterMatch | undefined,
): readonly Feature[] {
  const sort = useSidebarOption("conversationSort");
  const manualOrder = useManualConversationOrder();
  return useMemo(
    () =>
      sortConversations(
        filterMatch ? activeFeatures.filter((f) => filterMatch.has(f.id)) : activeFeatures,
        sort,
        manualOrder,
      ),
    [activeFeatures, filterMatch, manualOrder, sort],
  );
}

function useProjectFeatureLabels(data: ProjectFeaturesData) {
  const [editingFeatureId, setEditingFeatureId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const updateMutation = useUpdateFeatureLabel({
    mutation: {
      onSuccess: (_data, variables) => {
        setEditingFeatureId(null);
        setDraft("");
        invalidateFeatureQueries(variables.id, ["label"]);
      },
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to update feature label")),
    },
  });
  const start = useCallback((feature: Feature): void => {
    setEditingFeatureId(feature.id);
    setDraft(feature.label ?? "");
  }, []);
  const cancel = useCallback((): void => setEditingFeatureId(null), []);
  const save = useCallback(
    (featureId: number, override?: string): void => {
      const normalized = normalizeLabel(override ?? draft);
      const current = data.features.find((feature) => feature.id === featureId);
      if (current && normalizeLabel(current.label ?? "") === normalized) {
        setEditingFeatureId(null);
        setDraft("");
        return;
      }
      updateMutation.mutate({ id: featureId, data: { label: normalized } });
    },
    [data.features, draft, updateMutation],
  );
  const shortcut = useCallback(
    (event: KeyboardEvent): void => {
      if (!data.activeFeature || isInCodeMirrorEditor(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      start(data.activeFeature);
    },
    [data.activeFeature, start],
  );
  useGlobalShortcutById("edit-label", shortcut, { enabled: data.activeFeature != null });
  return useMemo(
    () => ({ cancel, draft, editingFeatureId, save, setDraft, start, updateMutation }),
    [cancel, draft, editingFeatureId, save, start, updateMutation],
  );
}

function useProjectFeatureActions(props: ProjectFeaturesProps, data: ProjectFeaturesData) {
  const navigate = useNavigate();
  const closeFeatureActivity = useCloseFeatureActivity();
  const archiveFeature = useArchiveFeatureAction({
    activeFeatureId: props.activeFeatureId,
    activeFeatures: data.activeFeatures,
    projectId: props.projectId,
  });
  const mutations = useFeatureRowMutations({
    activeFeatureId: props.activeFeatureId,
    activeFeatures: data.activeFeatures,
    projectId: props.projectId,
  });
  const navigateToFeature = useCallback(
    (feature: Feature, options?: FeatureNavigateOptions): void => {
      props.onSelectFeature(feature.id);
      const focusTab = options?.focusTab ?? getFocusedTabForFeature(props.activeFeatureId);
      const search = {
        cwd: props.projectPath,
        featureId: feature.id,
        projectId: props.projectId,
        ...(focusTab ? { focusTab } : {}),
      };
      void navigate({
        to: "/ws-session/$sessionId",
        params: { sessionId: wsSessionIdFromFeature(feature.id) },
        search,
      });
    },
    [navigate, props],
  );
  return {
    closeActivity: (
      featureId: number,
      shellCount: number,
      browserCount: number,
      downloadCount: number,
    ): void =>
      closeFeatureActivity({
        projectId: props.projectId,
        featureId,
        shellCount,
        browserCount,
        downloadCount,
      }),
    ...mutations,
    navigateToFeature,
    archiveFeature,
  };
}

type ProjectFeatureActions = ReturnType<typeof useProjectFeatureActions>;

function createFeatureRenderer(
  props: ProjectFeaturesProps,
  data: ProjectFeaturesData,
  labels: ReturnType<typeof useProjectFeatureLabels>,
  actions: ProjectFeatureActions,
  setConfirmFeatureId: (featureId: number | null) => void,
): RenderFeature {
  return (feature, hierarchyControl, hierarchyDepth = 0, hiddenDescendantIds) => (
    <ProjectFeatureRow
      key={feature.id}
      feature={feature}
      projectId={props.projectId}
      activeFeatureId={props.activeFeatureId}
      liveTitle={data.getLiveTitle(feature.id)}
      isAutoNaming={data.isAutoNaming(feature.id)}
      hasWorktree={data.worktreeFeatureIds.has(feature.id)}
      hasLiveWorktree={data.liveWorktreeFeatureIds.has(feature.id)}
      worktree={data.worktreeByFeatureId.get(feature.id)}
      shellCount={data.shellCountsByFeatureId.get(feature.id) ?? 0}
      browserCount={data.browserCountsByFeatureId[feature.id] ?? 0}
      downloadCount={data.downloadCountsByFeatureId[feature.id] ?? 0}
      ports={data.portsByFeatureId.get(feature.id) ?? NO_PORTS}
      isEditingLabel={labels.editingFeatureId === feature.id}
      labelDraft={labels.editingFeatureId === feature.id ? labels.draft : ""}
      labelSuggestions={data.labelSuggestions}
      isSavingLabel={labels.updateMutation.isPending && labels.editingFeatureId === feature.id}
      onNavigate={actions.navigateToFeature}
      onStartLabelEdit={labels.start}
      onLabelDraftChange={labels.setDraft}
      onSaveLabel={labels.save}
      onCancelLabelEdit={labels.cancel}
      onArchiveOrDelete={setConfirmFeatureId}
      onUnarchive={actions.unarchive}
      onTogglePin={actions.togglePin}
      onCloseActivity={actions.closeActivity}
      hierarchyControl={hierarchyControl}
      hierarchyDepth={hierarchyDepth}
      hiddenDescendantIds={hiddenDescendantIds}
    />
  );
}

export function useProjectFeaturesController(props: ProjectFeaturesProps) {
  const [confirmFeatureId, setConfirmFeatureId] = useState<number | null>(null);
  const data = useProjectFeaturesData(props);
  const { showArchived, toggleArchived } = useArchivedSectionOpen(
    props.projectId,
    data.activeFeature?.status === ARCHIVED_FEATURE_STATUS,
  );
  const collapsedSubtrees = usePersistedIdSet(SIDEBAR_COLLAPSED_SUBTREES_KEY);
  const labels = useProjectFeatureLabels(data);
  const actions = useProjectFeatureActions(props, data);
  const confirmation = useFeatureArchiveConfirmation(
    confirmFeatureId,
    data.features,
    data.worktreeByFeatureId,
  );
  const renderFeature = useMemo(
    () => createFeatureRenderer(props, data, labels, actions, setConfirmFeatureId),
    [actions, data, labels, props],
  );
  const renderSubtree = useCallback(
    (feature: Feature): ReactNode => {
      const node = data.rootNodeByFeatureId.get(feature.id);
      return node ? (
        <FeatureSubtree
          key={feature.id}
          node={node}
          renderFeature={renderFeature}
          collapsedIds={collapsedSubtrees.ids}
          onSetCollapsed={collapsedSubtrees.setMember}
        />
      ) : (
        renderFeature(feature)
      );
    },
    [collapsedSubtrees, data.rootNodeByFeatureId, renderFeature],
  );
  return {
    actions,
    orderedIds: data.orderedIds,
    renderedActiveFeatureCount: data.shownFeatures.filter((feature) => !feature.is_pinned).length,
    archivedFeatures: data.archivedFeatures,
    dormantFeatures: data.dormantFeatures,
    confirmFeatureId,
    confirmation,
    flatActiveFeatures: data.flatActiveFeatures,
    rootNodeByFeatureId: data.rootNodeByFeatureId,
    renderFeature,
    renderSubtree,
    reorderGroups: data.reorderGroups,
    setConfirmFeatureId,
    showArchived,
    toggleArchived,
    worktreeGroups: data.worktreeGroups,
  };
}

export type ProjectFeaturesController = ReturnType<typeof useProjectFeaturesController>;
