import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useMemo, type RefObject } from "react";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import type { ChangedFile } from "@/api/generated";
import { useInViewport } from "@/hooks/useInViewport";
import type { PrThreadLine } from "@/lib/pr-review-threads";
import type { DiffMode } from "./useDiffData";
import { DiffFileBlock, type DiffFileBlockProps } from "./DiffFileBlock";
import { DiffVirtualizer } from "./DiffVirtualizer";
import type { CommentSide } from "./PatchDiffView";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import type { OpenDiffInEditor } from "./OpenDiffInEditorContext";
import { sortChangedFilesForDiff } from "./useGitDiffFileTreeModel";

interface ActiveCommentWidget {
  filePath: string;
  lineNumber: number;
  side: CommentSide;
}

/**
 * One file row. Tracks its own viewport visibility so `DiffFileBlock` only
 * fetches this file's diff when it's on (or near) screen — the outer list
 * mounts every row, so without this a 400-file diff would fire 400 requests.
 */
const DiffRow = memo(function DiffRow({
  scrollRef,
  ...blockProps
}: { scrollRef: RefObject<HTMLDivElement | null> } & Omit<DiffFileBlockProps, "isVisible">) {
  const { setRef, inView } = useInViewport(scrollRef);
  return (
    <div
      ref={setRef}
      data-file={blockProps.file.file}
      className="relative isolate border-b border-border"
    >
      <DiffFileBlock {...blockProps} isVisible={inView} />
    </div>
  );
});

interface DiffContentProps {
  diffAreaRef: RefObject<HTMLDivElement | null>;
  files: ChangedFile[];
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  selectedCommit: string | null;
  diffMode: "unified" | "split";
  collapsedFiles: ReadonlySet<string>;
  activeFilePath: string | null;
  viewedFilesSet: Set<string>;
  isViewedPending: boolean;
  commentLinesByFile: Map<string, CommentLineData[]>;
  /** Unresolved forge review threads per file; absent outside the branch diff. */
  remoteThreadLinesByFile?: Map<string, PrThreadLine[]>;
  activeReviewThreadId?: string | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  activeCommentWidget: ActiveCommentWidget | null;
  memoizedActiveWidget: ActiveWidget | null;
  commentCallbacks: CommentCallbacks;
  onToggleFile: (fileName: string) => void;
  onMarkViewedFile: (fileName: string) => void;
  onUnmarkViewedFile: (fileName: string) => void;
  onOpenFileInEditor?: OpenDiffInEditor;
  indexActions?: GitFileIndexActions;
  onAddComment: (filePath: string, lineNumber: number, side?: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
}

function DiffContentImpl({
  diffAreaRef,
  files,
  featureId,
  mode,
  targetBranch,
  selectedCommit,
  diffMode,
  collapsedFiles,
  activeFilePath,
  viewedFilesSet,
  isViewedPending,
  commentLinesByFile,
  remoteThreadLinesByFile,
  activeReviewThreadId,
  selectedReviewThreadIds,
  onReviewThreadSelectedChange,
  activeCommentWidget,
  memoizedActiveWidget,
  commentCallbacks,
  onToggleFile,
  onMarkViewedFile,
  onUnmarkViewedFile,
  onOpenFileInEditor,
  indexActions,
  onAddComment,
  themeAppearance,
  themeId,
}: DiffContentProps) {
  const { t } = useUiTranslation();
  const orderedFiles = useMemo(() => sortChangedFilesForDiff(files), [files]);
  return (
    <>
      <DiffVirtualizer scrollRef={diffAreaRef}>
        {orderedFiles.map((file) => {
          const remoteThreadLines = remoteThreadLinesByFile?.get(file.file);
          const hasRemoteThreads = (remoteThreadLines?.length ?? 0) > 0;
          return (
            <DiffRow
              key={file.file}
              scrollRef={diffAreaRef}
              featureId={featureId}
              mode={mode}
              targetBranch={targetBranch}
              commitSha={selectedCommit}
              file={file}
              diffMode={diffMode}
              isCollapsed={collapsedFiles.has(file.file)}
              isFocused={file.file === activeFilePath}
              isFileViewed={viewedFilesSet.has(file.file)}
              isViewedPending={isViewedPending}
              showViewedCheckbox={!selectedCommit}
              commentLines={commentLinesByFile.get(file.file)}
              remoteThreadLines={remoteThreadLines}
              activeReviewThreadId={hasRemoteThreads ? activeReviewThreadId : undefined}
              selectedReviewThreadIds={hasRemoteThreads ? selectedReviewThreadIds : undefined}
              onReviewThreadSelectedChange={
                hasRemoteThreads ? onReviewThreadSelectedChange : undefined
              }
              activeWidget={
                activeCommentWidget?.filePath === file.file ? memoizedActiveWidget : null
              }
              commentCallbacks={commentCallbacks}
              onToggleFile={onToggleFile}
              onMarkViewedFile={onMarkViewedFile}
              onUnmarkViewedFile={onUnmarkViewedFile}
              onOpenFileInEditor={onOpenFileInEditor}
              indexActions={indexActions}
              onAddComment={onAddComment}
              themeAppearance={themeAppearance}
              themeId={themeId}
            />
          );
        })}
      </DiffVirtualizer>
      {isViewedPending && (
        <span className="sr-only" role="status">
          {t("workspace.git.diffContent.updatingViewedState", "Updating viewed state")}
        </span>
      )}
    </>
  );
}

export const DiffContent = memo(DiffContentImpl);
