import { memo, type RefObject } from "react";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import type { FileMeta } from "./useDiffData";
import { DiffFileBlock } from "./DiffFileBlock";
import { DiffVirtualizer } from "./DiffVirtualizer";
import type { CommentSide } from "./PatchDiffView";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";

interface ActiveCommentWidget {
  filePath: string;
  lineNumber: number;
  side: CommentSide;
}

interface DiffContentProps {
  diffAreaRef: RefObject<HTMLDivElement | null>;
  fileMeta: FileMeta[];
  selectedCommit: string | null;
  diffMode: "unified" | "split";
  collapsedFiles: Set<string>;
  focusedFileIndex: number;
  viewedFilesSet: Set<string>;
  commentLinesByFile: Map<string, CommentLineData[]>;
  activeCommentWidget: ActiveCommentWidget | null;
  memoizedActiveWidget: ActiveWidget | null;
  commentCallbacks: CommentCallbacks;
  onToggleFile: (fileName: string) => void;
  onMarkViewedFile: (fileName: string) => void;
  onUnmarkViewedFile: (fileName: string) => void;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
  onAddComment: (filePath: string, lineNumber: number, side?: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
}

function DiffContentImpl({
  diffAreaRef,
  fileMeta,
  selectedCommit,
  diffMode,
  collapsedFiles,
  focusedFileIndex,
  viewedFilesSet,
  commentLinesByFile,
  activeCommentWidget,
  memoizedActiveWidget,
  commentCallbacks,
  onToggleFile,
  onMarkViewedFile,
  onUnmarkViewedFile,
  onOpenFileInEditor,
  onAddComment,
  themeAppearance,
  themeId,
}: DiffContentProps) {
  return (
    <DiffVirtualizer scrollRef={diffAreaRef}>
      {fileMeta.map(({ section, displayName, additions, deletions }, fileIndex) => (
        <div
          key={displayName}
          data-file={displayName}
          className="relative isolate border-b border-border"
        >
          <DiffFileBlock
            section={section}
            diffMode={diffMode}
            displayName={displayName}
            isCollapsed={collapsedFiles.has(displayName)}
            isFocused={fileIndex === focusedFileIndex}
            isFileViewed={viewedFilesSet.has(displayName)}
            showViewedCheckbox={!selectedCommit}
            additions={additions}
            deletions={deletions}
            commentLines={commentLinesByFile.get(displayName)}
            activeWidget={
              activeCommentWidget?.filePath === displayName ? memoizedActiveWidget : null
            }
            commentCallbacks={commentCallbacks}
            onToggleFile={onToggleFile}
            onMarkViewedFile={onMarkViewedFile}
            onUnmarkViewedFile={onUnmarkViewedFile}
            onOpenFileInEditor={onOpenFileInEditor}
            onAddComment={onAddComment}
            themeAppearance={themeAppearance}
            themeId={themeId}
          />
        </div>
      ))}
    </DiffVirtualizer>
  );
}

export const DiffContent = memo(DiffContentImpl);
