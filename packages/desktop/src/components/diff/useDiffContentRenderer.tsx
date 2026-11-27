import { useCallback, type ReactElement, type RefObject } from "react";
import type { ChangedFile } from "@/api/generated";
import type { PrThreadLine, ReviewNavigationTarget } from "@/lib/pr-review-threads";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { DiffContent } from "./DiffContent";
import type { GitNavigationAdapterRegistrar } from "./gitNavigation";
import type { OpenDiffInEditor } from "./OpenDiffInEditorContext";
import type { useDiffData, DiffMode } from "./useDiffData";
import type { useDiffViewerComments } from "./useDiffViewerComments";
import type { DiffViewerNavigationState } from "./useDiffViewerNavigation";
import type { useGitFileIndexActions } from "./useGitFileIndexActions";
import type { GitFileListCollapseState } from "./useGitFileListCollapse";

export type DiffData = ReturnType<typeof useDiffData>;

export interface LoadedDiffViewerProps {
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
  /** The phone layout: list then one file (`PhoneDiffViewer`), named by `backLabel`. */
  phone?: { backLabel: string };
}

/** Builds the diff pane for a set of files; the phone layout shows one at a time. */
export function useDiffContentRenderer(
  props: LoadedDiffViewerProps,
  diffAreaRef: RefObject<HTMLDivElement | null>,
  navigation: DiffViewerNavigationState,
  comments: ReturnType<typeof useDiffViewerComments>,
  indexActions: ReturnType<typeof useGitFileIndexActions>,
  indexMutable: boolean,
): (files: ChangedFile[], collapsedFiles: ReadonlySet<string>) => ReactElement {
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
  return useCallback(
    (files, collapsedFiles) => (
      <DiffContent
        diffAreaRef={diffAreaRef}
        files={files}
        featureId={featureId}
        mode={mode}
        targetBranch={targetBranch}
        selectedCommit={data.selectedCommit}
        diffMode={diffMode}
        collapsedFiles={collapsedFiles}
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
