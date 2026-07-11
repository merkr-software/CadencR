import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { Button } from "@/components/ui/button";
import { SendIcon, Loader2Icon, PanelLeft, PanelLeftClose } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { DiffViewer } from "./diff/DiffViewer";
import { GitGraphView } from "./diff/GitGraphView";
import { StashesView } from "./diff/StashesView";
import { GitTabToggle, type GitViewMode } from "./diff/GitTabToggle";
import { NumStat } from "@/components/NumStat";
import type { DiffMode } from "./diff/useDiffData";
import {
  useListDiffComments,
  useGetFeatureSettings,
  useSetFeatureSetting,
  useGetStats,
  getGetFeatureSettingsQueryKey,
} from "@/api/generated";
import { useSendPendingComments } from "@/hooks/useSendPendingComments";
import { selectGitTargetBranch, useGitStatusStore } from "@/stores/useGitStatusStore";
import { apiErrorMessage } from "@/lib/api-errors";

const GIT_VIEW_MODE_SETTING = "git_view_mode";
const GIT_SIDEBAR_COLLAPSED_SETTING = "git_sidebar_collapsed";

interface FeatureGitTabProps {
  featureId: number;
  diffMode?: "worktree" | "branch";
  hotkeysEnabled?: boolean;
  /** Sends formatted comments to the current ws-session agent. */
  onSendComments?: (message: string) => void;
}

function isGitViewMode(v: string | undefined): v is GitViewMode {
  return v === "uncommitted" || v === "vs-target" || v === "graph" || v === "stashes";
}

export const FeatureGitTab = memo(function FeatureGitTab({
  featureId,
  diffMode = "worktree",
  hotkeysEnabled = true,
  onSendComments,
}: FeatureGitTabProps) {
  const queryClient = useQueryClient();
  const { data: comments = [] } = useListDiffComments(featureId);
  const pendingComments = useMemo(() => comments.filter((c) => c.status === "pending"), [comments]);
  const fallbackViewMode: GitViewMode = diffMode === "branch" ? "vs-target" : "uncommitted";

  // Per-feature persisted toggle. The `viewMode` local state holds the
  // user's pick; it stays in sync with the persisted setting via the effect
  // below, so reload / cross-tab switches resume on the right view. Local
  // state lets the toggle flip instantly without an optimistic cache write
  // (per `no-optimistic-updates.md`).
  const { data: settingsData } = useGetFeatureSettings(featureId);
  const persistedViewMode = useMemo<GitViewMode>(() => {
    const raw = settingsData?.find((s) => s.key === GIT_VIEW_MODE_SETTING)?.value;
    return isGitViewMode(raw) ? raw : fallbackViewMode;
  }, [fallbackViewMode, settingsData]);

  const [viewMode, setViewMode] = useState<GitViewMode>(persistedViewMode);
  useEffect(() => {
    setViewMode(persistedViewMode);
  }, [persistedViewMode]);

  const setFeatureSetting = useSetFeatureSetting({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetFeatureSettingsQueryKey(featureId) });
      },
      onError: (err: unknown) => {
        // Roll back the local pick so the UI matches the persisted state.
        setViewMode(persistedViewMode);
        const message = apiErrorMessage(err, "Unknown error");
        toast.error(`Could not save Git view setting: ${message}`);
      },
    },
  });

  const handleViewModeChange = useCallback(
    (next: GitViewMode) => {
      if (next === viewMode) return;
      setViewMode(next);
      setFeatureSetting.mutate({
        id: featureId,
        data: { key: GIT_VIEW_MODE_SETTING, value: next },
      });
    },
    [featureId, setFeatureSetting, viewMode],
  );

  // Only the target branch affects this component's query parameters. Selecting
  // the full live snapshot would re-render the entire Git tab whenever the
  // watcher advances `computed_at` for an agent file write; changed-files and
  // per-file diff queries already subscribe to their own cache updates below.
  const targetBranch = useGitStatusStore(selectGitTargetBranch(featureId));

  // The file-list collapse state lives here (alongside the new top toolbar)
  // so we can render the toggle next to the view-mode segmented control —
  // the user's specific request was to move the button up here. `DiffViewer`
  // accepts the controlled props and skips its own internal rail / tree
  // collapse buttons so there's a single source of truth.
  const {
    value: persistedFileListCollapsed,
    setValue: persistFileListCollapsed,
    isLoading: isFileListCollapseLoading,
  } = useDebouncedSetting(GIT_SIDEBAR_COLLAPSED_SETTING, 0);
  const fileListCollapsed = persistedFileListCollapsed === "true";
  const setFileListCollapsed = useCallback(
    (collapsed: boolean): void => {
      persistFileListCollapsed(String(collapsed));
    },
    [persistFileListCollapsed],
  );
  const handleToggleFileListCollapsed = useCallback((): void => {
    setFileListCollapsed(!fileListCollapsed);
  }, [fileListCollapsed, setFileListCollapsed]);

  // Translate the active toggle into the diff endpoints' `mode` parameter.
  // "uncommitted" hits the working-tree path on the server (alias of the legacy
  // "worktree" mode); "vs-target" pins the diff to the resolved target branch.
  const isGraph = viewMode === "graph";
  const isStashes = viewMode === "stashes";
  // The graph and stashes views carry their own per-row stats and drive their
  // own list body — they don't use the shared diff toolbar, file-list collapse,
  // or diff-wide stats query.
  const isListView = isGraph || isStashes;
  const effectiveDiffMode: DiffMode = viewMode === "vs-target" ? "branch" : "uncommitted";
  const diffTargetBranch = viewMode === "vs-target" ? targetBranch : undefined;
  // Stats are byte-identical for "worktree" and "uncommitted" on the backend, so
  // label the working-tree stats query "worktree" — the value ProjectFeatureRow
  // and the prefetch use — to share one cache entry instead of firing a
  // duplicate under the "uncommitted" key when the Git tab is open.
  const statsMode = viewMode === "vs-target" ? "branch" : "worktree";
  // The list views have their own per-row stats — skip the diff-wide stats
  // query entirely while one is active so we don't fire a wasted request.
  const statsQuery = useGetStats(
    {
      feature_id: featureId,
      mode: statsMode,
      target_branch: diffTargetBranch,
    },
    { query: { enabled: !isListView } },
  );

  const { send, sending, buttonLabel, disabled, shouldRender } = useSendPendingComments({
    featureId,
    pendingComments,
    onSend: onSendComments,
    verb: "Send",
  });

  useScopedGlobalShortcutById(
    "diff-toggle-sidebar",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      handleToggleFileListCollapsed();
    },
    "git",
    { enabled: hotkeysEnabled && !isFileListCollapseLoading },
  );

  useScopedGlobalShortcutById(
    "diff-send-comments",
    (e) => {
      e.preventDefault();
      void send();
    },
    "git",
    { enabled: hotkeysEnabled },
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        {!isListView && (
          <button
            type="button"
            onClick={handleToggleFileListCollapsed}
            disabled={isFileListCollapseLoading}
            aria-pressed={!fileListCollapsed}
            aria-label={fileListCollapsed ? "Expand file list" : "Collapse file list"}
            title={fileListCollapsed ? "Expand file list" : "Collapse file list"}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fileListCollapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        )}
        <GitTabToggle
          value={viewMode}
          onChange={handleViewModeChange}
          targetBranch={targetBranch}
        />
        {!isListView && (
          <GitToolbarNumStat
            isLoading={statsQuery.isLoading}
            isError={statsQuery.isError}
            additions={statsQuery.data?.insertions}
            deletions={statsQuery.data?.deletions}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {isGraph ? (
          <GitGraphView featureId={featureId} />
        ) : isStashes ? (
          <StashesView featureId={featureId} />
        ) : (
          <DiffViewer
            featureId={featureId}
            mode={effectiveDiffMode}
            targetBranch={diffTargetBranch}
            fileListCollapsed={fileListCollapsed}
            onFileListCollapsedChange={setFileListCollapsed}
          />
        )}
      </div>
      {shouldRender && (
        <div className="border-t px-4 py-3 flex justify-end">
          <ShortcutTooltip label={buttonLabel} keys={["cmd", "enter"]} above>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void send()}>
              {sending ? (
                <Loader2Icon className="mr-2 size-4 animate-spin" />
              ) : (
                <SendIcon className="mr-2 size-4" />
              )}
              {buttonLabel}
            </Button>
          </ShortcutTooltip>
        </div>
      )}
    </div>
  );
});

interface GitToolbarNumStatProps {
  isLoading: boolean;
  isError: boolean;
  additions: number | undefined;
  deletions: number | undefined;
}

function GitToolbarNumStat({
  isLoading,
  isError,
  additions,
  deletions,
}: GitToolbarNumStatProps): ReactElement {
  if (isLoading) {
    return <span className="text-xs text-muted-foreground animate-pulse">Loading stats…</span>;
  }
  if (isError) {
    return <span className="text-xs text-destructive">Stats unavailable</span>;
  }
  return (
    <NumStat
      additions={additions}
      deletions={deletions}
      hideZero={false}
      className="text-xs shrink-0"
    />
  );
}
