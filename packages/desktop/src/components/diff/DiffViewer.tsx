import { memo, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import type { PrThreadLine, ReviewNavigationTarget } from "@/lib/pr-review-threads";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useTheme } from "@/hooks/useTheme";
import { GIT_DIFF_VIEW_MODE_KEY, parseGitDiffViewMode } from "@/lib/git-diff-view-mode";
import { DiffContent } from "./DiffContent";
import { DiffLayout } from "./DiffLayout";
import { GitDiffToolbar } from "./GitDiffToolbar";
import { GitDiffFileTree } from "./GitDiffFileTree";
import { useDiffData, type DiffMode } from "./useDiffData";
import { useOpenDiffInEditor, type OpenDiffInEditor } from "./OpenDiffInEditorContext";
import { useGitPathEditorOpener } from "./useGitPathEditorOpener";
import { useGitFileIndexActions } from "./useGitFileIndexActions";
import { useGitFileListCollapse, type GitFileListCollapseState } from "./useGitFileListCollapse";
import { useDiffViewerComments } from "./useDiffViewerComments";
import { useDiffViewerNavigation } from "./useDiffViewerNavigation";
import type { DiffViewerNavigationState } from "./useDiffViewerNavigation";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import { scrollReviewThreadToCenter } from "./scroll-to-review-thread";

interface DiffViewerProps {
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  commitSha?: string | null;
  fileListCollapsed?: boolean;
  onFileListCollapsedChange?: (collapsed: boolean) => void;
  onOpenFileInEditor?: OpenDiffInEditor;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
  afterToolbar?: ReactNode;
  /**
   * Unresolved forge review threads keyed by file path. Only the branch diff
   * passes them: a review is written against the proposal's diff, so anchoring
   * those lines onto an unrelated working-tree diff would point at the wrong
   * rows.
   */
  remoteThreadLinesByFile?: Map<string, PrThreadLine[]>;
  reviewCountsByFile?: ReadonlyMap<string, number>;
  reviewTarget?: ReviewNavigationTarget | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
}

type DiffData = ReturnType<typeof useDiffData>;

interface LoadedDiffViewerProps {
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  data: DiffData;
  fileList: GitFileListCollapseState;
  diffMode: "unified" | "split";
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
  openFileInEditor?: OpenDiffInEditor;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
  remoteThreadLinesByFile?: Map<string, PrThreadLine[]>;
  reviewCountsByFile?: ReadonlyMap<string, number>;
  reviewTarget?: ReviewNavigationTarget | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
}

function DiffViewerMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div
      className={`flex h-full items-center justify-center bg-background px-4 text-center ${error ? "text-destructive" : "text-muted-foreground"}`}
      role={error ? "alert" : "status"}
    >
      <p>{children}</p>
    </div>
  );
}

function DiffQueryErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
      role="alert"
    >
      {message}
    </div>
  );
}

const DiffViewerLayout = memo(function DiffViewerLayout({
  data,
  fileList,
  tree,
  content,
}: {
  data: DiffData;
  fileList: GitFileListCollapseState;
  tree: ReactNode;
  content: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <DiffQueryErrorBanner message={data.errorMessage} />
      <DiffLayout
        collapsed={fileList.showCollapsedRail}
        controlled={fileList.isControlled}
        disabled={fileList.isLoading}
        sidebar={tree}
        content={content}
        onCollapsedChange={fileList.setCollapsed}
      />
    </div>
  );
});

function useLoadedDiffContent(
  props: LoadedDiffViewerProps,
  diffAreaRef: RefObject<HTMLDivElement | null>,
  navigation: DiffViewerNavigationState,
  comments: ReturnType<typeof useDiffViewerComments>,
  indexActions: ReturnType<typeof useGitFileIndexActions>,
  indexMutable: boolean,
): ReactNode {
  const {
    data,
    diffMode,
    featureId,
    mode,
    onReviewThreadSelectedChange,
    openFileInEditor,
    remoteThreadLinesByFile,
    reviewTarget,
    selectedReviewThreadIds,
    targetBranch,
    themeAppearance,
    themeId,
  } = props;
  return useMemo(
    () => (
      <DiffContent
        diffAreaRef={diffAreaRef}
        files={data.changedFiles}
        featureId={featureId}
        mode={mode}
        targetBranch={targetBranch}
        selectedCommit={data.selectedCommit}
        diffMode={diffMode}
        collapsedFiles={navigation.collapsedFiles}
        activeFilePath={navigation.activeFilePath}
        viewedFilesSet={data.viewedFilesSet}
        isViewedPending={data.markViewed.isPending || data.unmarkViewed.isPending}
        commentLinesByFile={comments.commentLinesByFile}
        remoteThreadLinesByFile={remoteThreadLinesByFile}
        activeReviewThreadId={reviewTarget?.threadId}
        selectedReviewThreadIds={selectedReviewThreadIds}
        onReviewThreadSelectedChange={onReviewThreadSelectedChange}
        activeCommentWidget={comments.activeCommentWidget}
        memoizedActiveWidget={comments.activeWidget}
        commentCallbacks={comments.callbacks}
        onToggleFile={navigation.toggleFile}
        onMarkViewedFile={navigation.markFileViewed}
        onUnmarkViewedFile={navigation.unmarkFileViewed}
        onOpenFileInEditor={openFileInEditor}
        indexActions={indexMutable ? indexActions : undefined}
        onAddComment={comments.addComment}
        themeAppearance={themeAppearance}
        themeId={themeId}
      />
    ),
    [
      comments,
      data,
      diffAreaRef,
      diffMode,
      featureId,
      indexActions,
      indexMutable,
      mode,
      navigation,
      onReviewThreadSelectedChange,
      openFileInEditor,
      remoteThreadLinesByFile,
      reviewTarget?.threadId,
      selectedReviewThreadIds,
      targetBranch,
      themeAppearance,
      themeId,
    ],
  );
}

function LoadedDiffViewer(props: LoadedDiffViewerProps) {
  const {
    featureId,
    mode,
    data,
    fileList,
    openFileInEditor,
    registerNavigationAdapter,
    reviewCountsByFile,
    reviewTarget,
  } = props;
  const indexActions = useGitFileIndexActions(featureId);
  const diffAreaRef = useRef<HTMLDivElement>(null);
  const indexMutable =
    (mode === "uncommitted" || mode === "worktree") && data.selectedCommit === null;
  const navigation = useDiffViewerNavigation({
    featureId,
    data,
    indexActions,
    diffAreaRef,
    onOpenFileInEditor: openFileInEditor,
    indexMutable,
    reviewCountsByFile,
    registerNavigationAdapter,
  });
  useReviewThreadJump(reviewTarget, navigation, diffAreaRef);
  const comments = useDiffViewerComments(featureId, data);
  const content = useLoadedDiffContent(
    props,
    diffAreaRef,
    navigation,
    comments,
    indexActions,
    indexMutable,
  );
  const tree = useMemo(
    () => (
      <GitDiffFileTree
        model={navigation.tree.model}
        files={data.changedFiles}
        expandedFiles={navigation.expandedFiles}
        indexActions={indexActions}
        displayMode={navigation.tree.displayMode}
        isDisplayModePending={navigation.tree.isDisplayModePending}
        onDisplayModeChange={navigation.tree.setDisplayMode}
        resolveFilePath={navigation.tree.resolveFilePath}
        onToggleExpand={navigation.toggleFile}
        onOpenFileInEditor={openFileInEditor}
        onCollapse={fileList.isControlled ? undefined : fileList.collapse}
        stageCheckboxesEnabled={indexMutable}
      />
    ),
    [data.changedFiles, fileList, indexActions, indexMutable, navigation, openFileInEditor],
  );
  return <DiffViewerLayout data={data} fileList={fileList} tree={tree} content={content} />;
}

function useReviewThreadJump(
  target: ReviewNavigationTarget | null | undefined,
  navigation: DiffViewerNavigationState,
  diffAreaRef: RefObject<HTMLDivElement | null>,
): void {
  const selectPath = navigation.tree.navigation.selectPath;
  const revealFile = navigation.revealFile;
  const cancelRevealScroll = navigation.cancelRevealScroll;
  useEffect(() => {
    if (!target) return;
    selectPath(target.filePath);
    revealFile(target.filePath);
    let frame = 0;
    let attempts = 0;
    let cancelThreadScroll = (): void => {};
    const findAndFocus = (): void => {
      const container = diffAreaRef.current;
      const element = visibleReviewThread(container, target.threadId);
      if (container && element) {
        cancelRevealScroll();
        cancelThreadScroll = scrollReviewThreadToCenter(container, target.threadId);
        element.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      // The outer diff virtualizer can continue reconciling estimated file
      // heights after its first jump. Re-issue the intent periodically rather
      // than accepting a mounted-but-zero-size annotation as a finished jump.
      if (attempts % 12 === 0) revealFile(target.filePath);
      if (attempts < 180) frame = requestAnimationFrame(findAndFocus);
    };
    frame = requestAnimationFrame(findAndFocus);
    return () => {
      cancelAnimationFrame(frame);
      cancelRevealScroll();
      cancelThreadScroll();
    };
  }, [cancelRevealScroll, diffAreaRef, revealFile, selectPath, target]);
}

export function visibleReviewThread(
  container: HTMLElement | null,
  threadId: string,
): HTMLElement | null {
  const selector = `[data-review-thread-id="${CSS.escape(threadId)}"]`;
  const element = container?.querySelector<HTMLElement>(selector) ?? null;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
}

function DiffViewerImpl({
  featureId,
  mode,
  targetBranch,
  commitSha,
  fileListCollapsed,
  onFileListCollapsedChange,
  onOpenFileInEditor,
  registerNavigationAdapter,
  afterToolbar,
  remoteThreadLinesByFile,
  reviewCountsByFile,
  reviewTarget,
  selectedReviewThreadIds,
  onReviewThreadSelectedChange,
}: DiffViewerProps) {
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = useGitPathEditorOpener(
    featureId,
    onOpenFileInEditor ?? contextOpenFileInEditor,
  );
  const {
    value,
    setValue: setDiffMode,
    isLoading: isDiffModeLoading,
    isSaving: isDiffModeSaving,
  } = useDebouncedSetting(GIT_DIFF_VIEW_MODE_KEY, 0, { immediateCache: false });
  const diffMode = parseGitDiffViewMode(value);
  const fileList = useGitFileListCollapse({
    controlledValue: fileListCollapsed,
    onControlledChange: onFileListCollapsedChange,
  });
  const { theme } = useTheme();
  const data = useDiffData(featureId, mode, targetBranch, commitSha);

  let content: ReactNode;
  if (data.isLoading) {
    content = <DiffViewerMessage>Loading diff...</DiffViewerMessage>;
  } else if (data.errorMessage && data.changedFiles.length === 0) {
    content = <DiffViewerMessage error>{data.errorMessage}</DiffViewerMessage>;
  } else if (data.changedFiles.length === 0) {
    content = <DiffViewerMessage>No changes detected</DiffViewerMessage>;
  } else {
    content = (
      <LoadedDiffViewer
        featureId={featureId}
        mode={mode}
        targetBranch={targetBranch}
        data={data}
        fileList={fileList}
        diffMode={diffMode}
        themeAppearance={theme.appearance}
        themeId={theme.id}
        openFileInEditor={openFileInEditor}
        registerNavigationAdapter={registerNavigationAdapter}
        remoteThreadLinesByFile={remoteThreadLinesByFile}
        reviewCountsByFile={reviewCountsByFile}
        reviewTarget={reviewTarget}
        selectedReviewThreadIds={selectedReviewThreadIds}
        onReviewThreadSelectedChange={onReviewThreadSelectedChange}
      />
    );
  }
  const supportsViewed = data.selectedCommit === null;
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <GitDiffToolbar
        diffMode={diffMode}
        onDiffModeChange={setDiffMode}
        isPreferenceLoading={isDiffModeLoading || isDiffModeSaving}
        viewedCount={supportsViewed ? data.viewedFilesSet.size : undefined}
        fileCount={supportsViewed ? data.changedFiles.length : undefined}
        isViewedPending={data.markViewed.isPending || data.unmarkViewed.isPending}
      />
      {afterToolbar}
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </div>
  );
}

// Mounted beside a streaming agent; stable props keep unrelated stream
// updates from repainting the virtualized tree and diff instances.
export const DiffViewer = memo(DiffViewerImpl);
