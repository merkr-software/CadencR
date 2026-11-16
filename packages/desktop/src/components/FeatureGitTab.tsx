import { memo, useCallback, useMemo } from "react";
import type { GitViewMode } from "./diff/GitTabToggle";
import { useListDiffComments, type CommentThread, type PrStatusSnapshot } from "@/api/generated";
import {
  useSendPendingComments,
  type UseSendPendingCommentsResult,
} from "@/hooks/useSendPendingComments";
import { usePrReviewThreads, type PrReviewThreads } from "@/hooks/usePrReviewThreads";
import { useAgentPathMapper } from "@/hooks/useGitPathPrefix";
import type { AgentPathMapper } from "@/lib/git-paths";
import { GitTabLayout } from "./diff/GitTabLayout";
import type { GitSendCommentsBarProps } from "./diff/GitSendCommentsBar";
import { useGitTabPanes } from "./diff/useGitTabPanes";
import { useGitTabReviews, type GitTabReviews } from "./diff/useGitTabReviews";
import { useGitTabShortcuts } from "./diff/useGitTabShortcuts";
import { useGitTabViewState } from "./diff/useGitTabViewState";
import {
  selectGitConflictCount,
  selectGitTargetBranch,
  selectGitUncommittedCount,
  useGitStatusStore,
} from "@/stores/useGitStatusStore";
import { mostUrgentTone, prIndicatorTone } from "@/components/PrStatusIndicators";
import { otherOpenPrs, threadPrs, viewedThreadPr } from "@/lib/thread-prs";
import { GitUpdateRecoveryRegion } from "./git-actions/GitUpdateRecoveryBanner";
import { useGitKeyboardController } from "./diff/useGitKeyboardController";
import { useGitViewShortcuts } from "./diff/useGitViewShortcuts";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { selectViewedPr, useViewedPrStore } from "@/stores/viewed-pr-store";
import { usePrAttention } from "./diff/usePrAttention";

interface FeatureGitTabProps {
  featureId: number;
  projectId: number;
  diffMode?: "worktree" | "branch";
  hotkeysEnabled?: boolean;
  /** Sends formatted comments to the current ws-session agent. */
  onSendComments?: (message: string) => void;
}

function useSendBarProps(
  drafts: UseSendPendingCommentsResult,
  reviews: ReturnType<typeof useGitTabReviews>,
  isPr: boolean,
): GitSendCommentsBarProps {
  return useMemo(
    () => ({
      drafts:
        drafts.shouldRender && !isPr
          ? {
              label: drafts.buttonLabel,
              disabled: drafts.disabled,
              sending: drafts.sending,
              onSend: () => void drafts.send(),
            }
          : undefined,
      reviews: reviews.canSend
        ? {
            selectedCount: reviews.selectedCount,
            totalCount: reviews.unresolved.length,
            disabled: reviews.sendDisabled,
            onSend: reviews.sendSelected,
            onClear: () => reviews.setAllThreadsSelected(false),
          }
        : undefined,
    }),
    [drafts, isPr, reviews],
  );
}

/**
 * The PR view reads the proposal picked in its tabs; the branch diff always
 * overlays the current branch's, the only one whose lines it draws.
 */
function useFeatureGitReviews(
  featureId: number,
  viewMode: GitViewMode,
  prStatus: PrStatusSnapshot | undefined,
  onSendComments: ((message: string) => void) | undefined,
): {
  reviewThreads: PrReviewThreads;
  reviews: GitTabReviews;
  toAgentPath: AgentPathMapper | undefined;
} {
  // Comments name repository-relative paths; the agent runs in the feature's directory.
  const toAgentPath = useAgentPathMapper(featureId);
  const picked = useViewedPrStore(selectViewedPr(featureId));
  const viewed = viewMode === "pr" ? viewedThreadPr(prStatus, picked) : undefined;
  const pr = viewMode === "pr" ? viewed?.pr : prStatus?.pr;
  const otherPrNumber = viewed && !viewed.isCurrent ? viewed.pr.number : undefined;
  const visible = (viewMode === "pr" || viewMode === "vs-target") && pr != null;
  const reviewThreads = usePrReviewThreads(featureId, visible, otherPrNumber);
  const reviews = useGitTabReviews(viewMode, pr, onSendComments, reviewThreads, toAgentPath);
  return useMemo(
    () => ({ reviewThreads, reviews, toAgentPath }),
    [reviewThreads, reviews, toAgentPath],
  );
}

function useFeatureGitShortcuts(
  enabled: boolean,
  view: ReturnType<typeof useGitTabViewState>,
  panes: ReturnType<typeof useGitTabPanes>,
  drafts: UseSendPendingCommentsResult,
  reviews: GitTabReviews,
): void {
  useGitTabShortcuts({
    enabled,
    toggleFileList: view.toggleFileList,
    isFileListCollapseLoading: view.isFileListCollapseLoading,
    isListView: panes.isListView,
    isPr: panes.isPr,
    sendDrafts: () => void drafts.send(),
    sendReviewThreads: reviews.sendSelected,
    canSendReviewThreads: reviews.canSend && !reviews.sendDisabled,
    previousReview: reviews.previousThread,
    nextReview: reviews.nextThread,
    canNavigateReviews: view.viewMode === "vs-target" && reviews.targetCount > 0,
  });
}

/**
 * The body's review slice: what the diff annotates, and what the developer can
 * hand to the agent. Selection callbacks drop out entirely when the forge is
 * not sendable, which is what keeps the checkboxes off a read-only view.
 */
function reviewBodyProps(
  reviews: GitTabReviews,
  reviewThreads: PrReviewThreads,
  onViewReviewThread: (thread: CommentThread) => void,
) {
  return {
    reviewThreads,
    remoteThreadLinesByFile: reviews.remoteThreadLinesByFile,
    reviewCountsByFile: reviews.reviewCountsByFile,
    reviewTarget: reviews.activeTarget,
    selectedReviewThreadIds: reviews.selectedThreadIds,
    onReviewThreadSelectedChange: reviews.canSend ? reviews.setThreadSelected : undefined,
    onAllReviewThreadsSelectedChange: reviews.canSend ? reviews.setAllThreadsSelected : undefined,
    onViewReviewThread,
    onSendReviewThread: reviews.sendThread,
  };
}

export const FeatureGitTab = memo(function FeatureGitTab({
  featureId,
  projectId,
  diffMode = "worktree",
  hotkeysEnabled = true,
  onSendComments,
}: FeatureGitTabProps) {
  const { data: comments = [] } = useListDiffComments(featureId);
  const pendingComments = useMemo(() => comments.filter((c) => c.status === "pending"), [comments]);
  const registerNavigationAdapter = useGitKeyboardController(hotkeysEnabled);
  const fallbackViewMode: GitViewMode = diffMode === "branch" ? "vs-target" : "uncommitted";

  const view = useGitTabViewState(featureId, fallbackViewMode);
  const handleRequestUncommitted = useCallback(
    () => view.setViewMode("uncommitted"),
    [view.setViewMode],
  );
  const recoveryRegion = useMemo(
    () => (
      <GitUpdateRecoveryRegion
        featureId={featureId}
        onRequestUncommitted={handleRequestUncommitted}
      />
    ),
    [featureId, handleRequestUncommitted],
  );
  // Not gated on a save being in flight. The strip deliberately keeps every tab
  // clickable while one lands, and freezing the keyboard for the same window
  // would make the faster way in the only one that stops responding.
  // `setViewMode` already ignores a repeat of the current view.
  useGitViewShortcuts(view.setViewMode, hotkeysEnabled);

  // Only the target branch affects this component's query parameters. Selecting
  // the full live snapshot would re-render the entire Git tab whenever the
  // watcher advances `computed_at` for an agent file write; changed-files and
  // per-file diff queries already subscribe to their own cache updates.
  const targetBranch = useGitStatusStore(selectGitTargetBranch(featureId));
  const uncommittedCount = useGitStatusStore(selectGitUncommittedCount(featureId));
  const conflictCount = useGitStatusStore(selectGitConflictCount(featureId));
  const prStatus = usePrStatusStore(selectPrStatus(featureId));
  const panes = useGitTabPanes(featureId, view.viewMode, targetBranch);
  const prAttention = usePrAttention(prStatus, panes.isPr);
  const otherPrs = useMemo(() => {
    const prs = threadPrs(prStatus);
    return otherOpenPrs(
      prs,
      prs.find((entry) => entry.isCurrent),
    );
  }, [prStatus]);
  const { reviewThreads, reviews, toAgentPath } = useFeatureGitReviews(
    featureId,
    view.viewMode,
    prStatus,
    onSendComments,
  );
  const drafts = useSendPendingComments({
    featureId,
    pendingComments,
    toAgentPath,
    onSend: onSendComments,
  });
  const handleViewReviewThread = useCallback(
    (thread: CommentThread): void => {
      reviews.focusThread(thread);
      view.setViewMode("vs-target");
    },
    [reviews.focusThread, view.setViewMode],
  );
  const send = useSendBarProps(drafts, reviews, panes.isPr);

  useFeatureGitShortcuts(hotkeysEnabled, view, panes, drafts, reviews);

  return (
    <GitTabLayout
      reviews={reviews}
      recoveryRegion={recoveryRegion}
      toolbar={{
        viewMode: view.viewMode,
        onViewModeChange: view.setViewMode,
        targetBranch,
        prLabel: prStatus?.pr?.pr_label,
        prNumber: prStatus?.pr?.number,
        prTone: prIndicatorTone(prStatus),
        prAttention,
        prOtherCount: otherPrs.length,
        prOtherTone: mostUrgentTone(otherPrs),
        uncommittedCount,
        conflictCount,
        pendingViewMode: view.pendingViewMode,
        isListView: panes.isListView,
        fileListCollapsed: view.fileListCollapsed,
        isFileListCollapseLoading: view.isFileListCollapseLoading,
        onToggleFileList: view.toggleFileList,
        stats: panes.stats,
      }}
      body={{
        viewMode: view.viewMode,
        featureId,
        projectId,
        diffMode: panes.diffMode,
        diffTargetBranch: panes.diffTargetBranch,
        fileListCollapsed: view.fileListCollapsed,
        onFileListCollapsedChange: view.setFileListCollapsed,
        onRequestUncommitted: handleRequestUncommitted,
        registerNavigationAdapter,
        recoveryRegion,
        ...reviewBodyProps(reviews, reviewThreads, handleViewReviewThread),
      }}
      send={send}
    />
  );
});
