import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFeatures,
  useUpdateFeatureStatus,
  useUpdateFeatureLabel,
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
import { getFileName } from "@/lib/file-language";

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

  const worktreeByFeatureId = useMemo(() => {
    const map = new Map<number, FeatureWorktreeInfo>();
    for (const w of featureWorktrees) map.set(w.feature_id, w);
    return map;
  }, [featureWorktrees]);

  const { worktreeGroups, flatActiveFeatures } = useMemo(() => {
    // First pass: count features per non-main worktree path so we know which
    // paths qualify as groups (>= 2 features).
    const counts = new Map<string, number>();
    for (const f of activeFeatures) {
      const wt = worktreeByFeatureId.get(f.id);
      if (wt && wt.worktree_path !== projectPath) {
        counts.set(wt.worktree_path, (counts.get(wt.worktree_path) ?? 0) + 1);
      }
    }
    // Second pass: place each feature in flat or its group bucket. Group order
    // and intra-group order both follow activeFeatures iteration order.
    const flat: Feature[] = [];
    const groups: { key: string; label: string; features: Feature[] }[] = [];
    const groupByPath = new Map<string, Feature[]>();
    for (const f of activeFeatures) {
      const wt = worktreeByFeatureId.get(f.id);
      const path = wt?.worktree_path;
      if (!wt || path === projectPath || (counts.get(path!) ?? 0) < 2) {
        flat.push(f);
        continue;
      }
      let features = groupByPath.get(path!);
      if (!features) {
        features = [];
        groupByPath.set(path!, features);
        groups.push({
          key: path!,
          label: wt.worktree_branch ?? (getFileName(path!) || path!),
          features,
        });
      }
      features.push(f);
    }
    return { worktreeGroups: groups, flatActiveFeatures: flat };
  }, [activeFeatures, worktreeByFeatureId, projectPath]);

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
      onSuccess: invalidateFeatures,
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Failed to update feature status"));
      },
    },
  });

  const deleteMutation = useDeleteFeature({
    mutation: {
      onSuccess: (_data, variables) => {
        const deletedId = variables.id;
        if (deletedId === activeFeatureId) {
          const idx = activeFeatures.findIndex((f) => f.id === deletedId);
          const next = activeFeatures[idx + 1] ?? activeFeatures[idx - 1];
          if (next) {
            void navigate({
              to: "/projects/$projectId/features/$featureId",
              params: {
                projectId: String(projectId),
                featureId: String(next.id),
              },
            });
          } else {
            void navigate({ to: "/" });
          }
        }
        invalidateFeatures();
      },
    },
  });

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
    />
  );

  const confirmFeature = features.find((f) => f.id === confirmFeatureId);
  const isConfirmDelete = confirmFeature?.status === ARCHIVED_FEATURE_STATUS;

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
        open={confirmFeatureId != null && !isConfirmDelete}
        feature={confirmFeature}
        projectId={projectId}
        hasLiveWorktree={confirmFeature ? liveWorktreeFeatureIds.has(confirmFeature.id) : false}
        onOpenChange={(open) => {
          if (!open) setConfirmFeatureId(null);
        }}
        onArchive={(featureId) => {
          updateStatusMutation.mutate({
            id: featureId,
            data: { status: ARCHIVED_FEATURE_STATUS },
          });
        }}
      />

      <ConfirmDialog
        open={confirmFeatureId != null && isConfirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmFeatureId(null);
        }}
        title="Delete archived session?"
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

function WorktreeGroup({
  label,
  features,
  renderFeature,
}: {
  label: string;
  features: readonly Feature[];
  renderFeature: (feature: Feature) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-muted/30 p-1">
      <div
        className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground"
        title={label}
      >
        <GitBranchIcon className="size-3 shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
        <span className="shrink-0 opacity-70">({features.length})</span>
      </div>
      {features.map(renderFeature)}
    </div>
  );
}

function uniqueLabels(features: readonly Feature[]): string[] {
  const labels = new Set<string>();
  for (const feature of features) {
    const label = normalizeLabel(feature.label ?? "");
    if (label) labels.add(label);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

function normalizeLabel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
