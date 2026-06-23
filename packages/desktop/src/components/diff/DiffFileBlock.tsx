import { memo, useCallback } from "react";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { firstChangedNewLine } from "@/lib/diff-line";
import { type FileDiffSection, hasTextHunks } from "@/lib/parse-unified-diff";
import { DiffFileHeader } from "./DiffFileHeader";
import {
  type CommentLineData,
  type ActiveWidget,
  type CommentCallbacks,
} from "./diff-comment-decorations";
import { LargeDiffPlaceholder } from "./LargeDiffPlaceholder";
import { PatchDiffView, type CommentSide } from "./PatchDiffView";
import { DiffStatusIcon, deriveChangeType } from "./DiffStatusIcon";

export interface DiffFileBlockProps {
  section: FileDiffSection;
  diffMode: "unified" | "split";
  displayName: string;
  isCollapsed: boolean;
  isFocused: boolean;
  isFileViewed: boolean;
  showViewedCheckbox: boolean;
  additions: number;
  deletions: number;
  commentLines?: CommentLineData[];
  activeWidget?: ActiveWidget | null;
  commentCallbacks?: CommentCallbacks;
  onToggleFile: (fileName: string) => void;
  onMarkViewedFile: (fileName: string) => void;
  onUnmarkViewedFile: (fileName: string) => void;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
  onAddComment?: (filePath: string, lineNumber: number, side?: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
}

function isBinaryPatch(patch: string): boolean {
  return (
    /(?:^|\n)Binary files .* differ(?:\n|$)/.test(patch) ||
    /(?:^|\n)GIT binary patch(?:\n|$)/.test(patch)
  );
}

function DiffFileBlockImpl({
  section,
  diffMode,
  displayName,
  isCollapsed,
  isFocused,
  isFileViewed,
  showViewedCheckbox,
  additions,
  deletions,
  commentLines,
  activeWidget,
  commentCallbacks,
  onToggleFile,
  onMarkViewedFile,
  onUnmarkViewedFile,
  onOpenFileInEditor,
  onAddComment,
  themeAppearance,
  themeId,
}: DiffFileBlockProps) {
  const patch = section.hunks[0] ?? "";
  const hasHunks = hasTextHunks(section);
  const isBinary = !hasHunks && isBinaryPatch(patch);
  const onToggle = useCallback((): void => onToggleFile(displayName), [displayName, onToggleFile]);
  const onMarkViewed = useCallback(
    (): void => onMarkViewedFile(displayName),
    [displayName, onMarkViewedFile],
  );
  const onUnmarkViewed = useCallback(
    (): void => onUnmarkViewedFile(displayName),
    [displayName, onUnmarkViewedFile],
  );
  const onAddLineComment = useCallback(
    (lineNumber: number, side: CommentSide): void => onAddComment?.(displayName, lineNumber, side),
    [displayName, onAddComment],
  );
  const onOpenFile = useCallback(
    (): void => onOpenFileInEditor?.(displayName, firstChangedNewLine(section.hunks[0] ?? "")),
    [displayName, onOpenFileInEditor, section.hunks],
  );

  // One header for both states: collapsed renders it alone (cheap — no Pierre);
  // expanded renders it above a Pierre body whose own header is disabled, so the
  // row looks identical either way (font, status icon, counts, edit, viewed).
  const header = (
    <DiffFileHeader
      displayName={displayName}
      additions={additions}
      deletions={deletions}
      isCollapsed={isCollapsed}
      isFocused={isFocused}
      isFileViewed={isFileViewed}
      showViewedCheckbox={showViewedCheckbox}
      statusIcon={<DiffStatusIcon type={deriveChangeType(section)} appearance={themeAppearance} />}
      themeAppearance={themeAppearance}
      onToggle={onToggle}
      onOpenFileInEditor={onOpenFileInEditor ? onOpenFile : undefined}
      onMarkViewed={onMarkViewed}
      onUnmarkViewed={onUnmarkViewed}
    />
  );

  if (isCollapsed) return header;

  return (
    <>
      {header}
      <PatchDiffView
        patch={patch}
        mode={diffMode}
        commentLines={commentLines}
        activeWidget={activeWidget}
        commentCallbacks={commentCallbacks}
        themeAppearance={themeAppearance}
        themeId={themeId}
        focused={isFocused}
        disableFileHeader
        onAddComment={onAddComment ? onAddLineComment : undefined}
      />
      {isBinary && (
        <LargeDiffPlaceholder
          variant="binary"
          sizeBytes={0}
          additions={additions}
          deletions={deletions}
        />
      )}
      {!hasHunks && !isBinary && (
        <div className="border-t border-border bg-[var(--editor-bg)] px-4 py-3 font-mono text-xs text-muted-foreground">
          No text hunks in this file diff.
        </div>
      )}
    </>
  );
}

function arePropsEqual(prev: DiffFileBlockProps, next: DiffFileBlockProps): boolean {
  for (const key of Object.keys(next) as (keyof DiffFileBlockProps)[]) {
    if (key === "section") continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  const a = prev.section;
  const b = next.section;
  return (
    a.oldFileName === b.oldFileName &&
    a.newFileName === b.newFileName &&
    a.hunks.length === b.hunks.length &&
    a.hunks.every((hunk, index) => hunk === b.hunks[index])
  );
}

export const DiffFileBlock = memo(DiffFileBlockImpl, arePropsEqual);
