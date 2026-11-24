import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import type { ChangedFile } from "@/api/generated";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { PrThreadLine, ReviewNavigationTarget } from "@/lib/pr-review-threads";
import { useSetting } from "@/hooks/useSetting";
import { useTheme } from "@/hooks/useTheme";
import { GIT_DIFF_VIEW_MODE_KEY, parseGitDiffViewMode } from "@/lib/git-diff-view-mode";
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
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import { useReviewThreadJump } from "./useReviewThreadJump";
import { PhoneDiffViewer } from "./PhoneDiffViewer";
import { gitTargetLabel } from "./gitViews";
import {
  useDiffContentRenderer,
  type DiffData,
  type LoadedDiffViewerProps,
} from "./useDiffContentRenderer";

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

const NONE_COLLAPSED: ReadonlySet<string> = new Set();

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
    // The phone layout's steps register their own (`PhoneDiffViewer`): the
    // tree's selection is hidden there and must never pick the file acted on.
    registerNavigationAdapter: props.phone ? undefined : registerNavigationAdapter,
  });
  useReviewThreadJump(reviewTarget, navigation, diffAreaRef);
  const comments = useDiffViewerComments(featureId, data);
  const renderContent = useDiffContentRenderer(
    props,
    diffAreaRef,
    navigation,
    comments,
    indexActions,
    indexMutable,
  );
  const content = useMemo(
    () => renderContent(data.changedFiles, navigation.collapsedFiles),
    [data.changedFiles, navigation.collapsedFiles, renderContent],
  );
  const renderPhoneFiles = useCallback(
    (files: ChangedFile[]) => renderContent(files, NONE_COLLAPSED),
    [renderContent],
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
  if (props.phone) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <DiffQueryErrorBanner message={data.errorMessage} />
        <PhoneDiffViewer
          featureId={featureId}
          files={data.changedFiles}
          renderFiles={renderPhoneFiles}
          diffAreaRef={diffAreaRef}
          registerNavigationAdapter={registerNavigationAdapter}
          backLabel={props.phone.backLabel}
          showCommitBar={indexMutable}
          viewedFiles={data.viewedFilesSet}
          supportsViewed={data.selectedCommit === null}
          isViewedPending={data.markViewed.isPending || data.unmarkViewed.isPending}
          markFileViewed={navigation.markFileViewed}
          unmarkFileViewed={navigation.unmarkFileViewed}
          indexActions={indexMutable ? indexActions : undefined}
          openFileInEditor={openFileInEditor}
          reviewCountsByFile={reviewCountsByFile}
          reviewTarget={reviewTarget}
          appearance={props.themeAppearance}
        />
      </div>
    );
  }
  return <DiffViewerLayout data={data} fileList={fileList} tree={tree} content={content} />;
}

/** What the phone layout's list is called, on its Back button. */
function diffListLabel(
  mode: DiffMode,
  targetBranch: string | undefined,
  commitSha: string | null | undefined,
  t: UiTranslator,
): string {
  if (commitSha) return t("workspace.git.diffViewer.files", "Files");
  if (mode === "branch") return gitTargetLabel(targetBranch, t);
  return t("workspace.git.gitTabToggle.changes", "Changes");
}

/** The phone layout's list, named on its Back button; `undefined` off the phone layout. */
function usePhoneDiffLayout(
  mode: DiffMode,
  targetBranch: string | undefined,
  commitSha: string | null | undefined,
) {
  const { t } = useUiTranslation();
  const phone = useIsMobile();
  const phoneLayout = useMemo(
    () => (phone ? { backLabel: diffListLabel(mode, targetBranch, commitSha, t) } : undefined),
    [commitSha, mode, phone, t, targetBranch],
  );
  return { phone, phoneLayout };
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
  const { t } = useUiTranslation();
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
  } = useSetting(GIT_DIFF_VIEW_MODE_KEY);
  const { phone, phoneLayout } = usePhoneDiffLayout(mode, targetBranch, commitSha);
  // The phone layout's diff is one column wide: always unified.
  const diffMode = phone ? "unified" : parseGitDiffViewMode(value);
  const fileList = useGitFileListCollapse({
    controlledValue: fileListCollapsed,
    onControlledChange: onFileListCollapsedChange,
  });
  const { theme } = useTheme();
  const data = useDiffData(featureId, mode, targetBranch, commitSha);

  let content: ReactNode;
  if (data.isLoading) {
    content = (
      <DiffViewerMessage>
        {t("workspace.git.diffViewer.loadingDiff", "Loading diff...")}
      </DiffViewerMessage>
    );
  } else if (data.errorMessage && data.changedFiles.length === 0) {
    content = <DiffViewerMessage error>{data.errorMessage}</DiffViewerMessage>;
  } else if (data.changedFiles.length === 0) {
    content = (
      <DiffViewerMessage>
        {t("workspace.git.diffViewer.noChangesDetected", "No changes detected")}
      </DiffViewerMessage>
    );
  } else {
    content = (
      <LoadedDiffViewer
        featureId={featureId}
        mode={mode}
        targetBranch={targetBranch}
        data={data}
        fileList={fileList}
        key={phone ? `phone:${mode}:${targetBranch ?? ""}:${commitSha ?? ""}` : "desktop"}
        phone={phoneLayout}
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
      {!phone && (
        <GitDiffToolbar
          diffMode={diffMode}
          onDiffModeChange={setDiffMode}
          isPreferenceLoading={isDiffModeLoading || isDiffModeSaving}
          viewedCount={supportsViewed ? data.viewedFilesSet.size : undefined}
          fileCount={supportsViewed ? data.changedFiles.length : undefined}
          isViewedPending={data.markViewed.isPending || data.unmarkViewed.isPending}
        />
      )}
      {afterToolbar}
      {mode !== "branch" && supportsViewed && data.commentChecksNotice && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">
          {data.commentChecksNotice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
    </div>
  );
}

// Mounted beside a streaming agent; stable props keep unrelated stream
// updates from repainting the virtualized tree and diff instances.
export const DiffViewer = memo(DiffViewerImpl);
