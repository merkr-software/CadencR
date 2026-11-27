import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useCallback } from "react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { firstChangedNewLine } from "@/lib/diff-line";
import type { PrThreadLine } from "@/lib/pr-review-threads";
import { isLargeDiffByLines } from "@/lib/diff-thresholds";
import { DiffFileHeader } from "./DiffFileHeader";
import {
  type CommentLineData,
  type ActiveWidget,
  type CommentCallbacks,
} from "./diff-comment-decorations";
import { DiffFileBody, DiffFileNotice } from "./DiffFileBody";
import { LargeDiffPlaceholder } from "./LargeDiffPlaceholder";
import type { CommentSide } from "./PatchDiffView";
import { DiffStatusIcon, deriveChangeTypeFromStatus } from "./DiffStatusIcon";
import { useFileDiffSection } from "./useFileDiffSection";
import type { DiffMode } from "./useDiffData";
import type { GitFileIndexActions } from "./useGitFileIndexActions";
import { GitConflictFileBanner } from "./GitConflictFileBanner";
import type { OpenDiffInEditor } from "./OpenDiffInEditorContext";
import { resolvedStageState } from "./useGitDiffFileTreeModel";

export interface DiffFileBlockProps {
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  commitSha?: string | null;
  file: ChangedFile;
  /**
   * Whether the row is on (or near) screen. All rows mount — the outer list
   * isn't component-virtualized — so this gates the per-file diff fetch to the
   * files actually in view instead of firing one request per changed file.
   */
  isVisible: boolean;
  diffMode: "unified" | "split";
  isCollapsed: boolean;
  isFocused: boolean;
  isFileViewed: boolean;
  isViewedPending: boolean;
  showViewedCheckbox: boolean;
  commentLines?: CommentLineData[];
  /** Unresolved forge review threads anchored to this file. */
  remoteThreadLines?: PrThreadLine[];
  activeReviewThreadId?: string | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  activeWidget?: ActiveWidget | null;
  commentCallbacks?: CommentCallbacks;
  onToggleFile: (fileName: string) => void;
  onMarkViewedFile: (fileName: string) => void;
  onUnmarkViewedFile: (fileName: string) => void;
  onOpenFileInEditor?: OpenDiffInEditor;
  indexActions?: GitFileIndexActions;
  onAddComment?: (filePath: string, lineNumber: number, side?: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
}

function DiffFileBlockHeader({ props, patch }: { props: DiffFileBlockProps; patch?: string }) {
  const {
    file,
    isCollapsed,
    isFocused,
    isFileViewed,
    isViewedPending,
    showViewedCheckbox,
    onToggleFile,
    onMarkViewedFile,
    onUnmarkViewedFile,
    onOpenFileInEditor,
    themeAppearance,
    indexActions,
  } = props;
  const { status, file: displayName, additions, deletions } = file;
  const conflicted = resolvedStageState(file) === FileStageState.conflicted;
  const onToggle = useCallback((): void => onToggleFile(displayName), [displayName, onToggleFile]);
  const onMarkViewed = useCallback(
    (): void => onMarkViewedFile(displayName),
    [displayName, onMarkViewedFile],
  );
  const onUnmarkViewed = useCallback(
    (): void => onUnmarkViewedFile(displayName),
    [displayName, onUnmarkViewedFile],
  );
  const onOpenFile = useCallback(
    (): void => onOpenFileInEditor?.(displayName, firstChangedNewLine(patch ?? "")),
    [displayName, onOpenFileInEditor, patch],
  );

  return (
    <>
      <DiffFileHeader
        displayName={displayName}
        additions={additions}
        deletions={deletions}
        isCollapsed={isCollapsed}
        isFocused={isFocused}
        isFileViewed={isFileViewed}
        isViewedPending={isViewedPending}
        showViewedCheckbox={showViewedCheckbox}
        statusIcon={
          <DiffStatusIcon type={deriveChangeTypeFromStatus(status)} appearance={themeAppearance} />
        }
        themeAppearance={themeAppearance}
        onToggle={onToggle}
        onOpenFileInEditor={onOpenFileInEditor ? onOpenFile : undefined}
        file={file}
        indexActions={indexActions}
        onMarkViewed={onMarkViewed}
        onUnmarkViewed={onUnmarkViewed}
      />
      {conflicted && (
        <GitConflictFileBanner
          file={file}
          indexActions={indexActions}
          onOpenFileInEditor={onOpenFileInEditor ? onOpenFile : undefined}
        />
      )}
    </>
  );
}

function ExpandedDiffFileBlock(props: DiffFileBlockProps) {
  const { t } = useUiTranslation();
  const {
    featureId,
    mode,
    targetBranch,
    commitSha,
    file,
    isVisible,
    diffMode,
    commentLines,
    remoteThreadLines,
    activeReviewThreadId,
    selectedReviewThreadIds,
    onReviewThreadSelectedChange,
    activeWidget,
    commentCallbacks,
    onAddComment,
    themeAppearance,
    themeId,
    isFocused,
  } = props;
  const { status, file: displayName, additions, deletions } = file;
  const oldFile = file.old_file ?? undefined;
  const isLargeByLines = isLargeDiffByLines(additions, deletions);
  const reviewNeedsDisplay =
    activeReviewThreadId != null &&
    remoteThreadLines?.some((line) =>
      line.threads.some((thread) => thread.id === activeReviewThreadId),
    ) === true;

  const { section, rawLength, isDeferredLarge, isLoading, errorMessage, displayLargeDiff } =
    useFileDiffSection({
      featureId,
      filePath: displayName,
      oldFilePath: oldFile,
      mode,
      targetBranch,
      commitSha: commitSha ?? null,
      enabled: isVisible,
      allowLargeParse: reviewNeedsDisplay,
      isLargeByLines,
    });
  const patch = section?.hunks[0] ?? "";

  const onAddLineComment = useCallback(
    (lineNumber: number, side: CommentSide): void => onAddComment?.(displayName, lineNumber, side),
    [displayName, onAddComment],
  );

  return (
    <>
      <DiffFileBlockHeader props={props} patch={patch} />
      {errorMessage ? (
        <DiffFileNotice tone="error">{errorMessage}</DiffFileNotice>
      ) : isDeferredLarge ? (
        <LargeDiffPlaceholder
          variant="large"
          sizeBytes={rawLength ?? undefined}
          additions={additions}
          deletions={deletions}
          onDisplay={displayLargeDiff}
        />
      ) : section === null || isLoading ? (
        <DiffFileNotice>
          {t("workspace.git.diffFileBlock.loadingDiff", "Loading diff…")}
        </DiffFileNotice>
      ) : (
        <DiffFileBody
          featureId={featureId}
          displayName={displayName}
          oldFile={oldFile}
          status={status}
          mode={mode}
          targetBranch={targetBranch}
          commitSha={commitSha}
          section={section}
          patch={patch}
          diffMode={diffMode}
          additions={additions}
          deletions={deletions}
          commentLines={commentLines}
          remoteThreadLines={remoteThreadLines}
          activeReviewThreadId={activeReviewThreadId}
          selectedReviewThreadIds={selectedReviewThreadIds}
          onReviewThreadSelectedChange={onReviewThreadSelectedChange}
          activeWidget={activeWidget}
          commentCallbacks={commentCallbacks}
          onAddLineComment={onAddComment ? onAddLineComment : undefined}
          themeAppearance={themeAppearance}
          themeId={themeId}
          isFocused={isFocused}
        />
      )}
    </>
  );
}

function DiffFileBlockImpl(props: DiffFileBlockProps) {
  // A collapsed row stays header-only: no per-file patch or image requests.
  if (props.isCollapsed) return <DiffFileBlockHeader props={props} />;
  return <ExpandedDiffFileBlock {...props} />;
}

export const DiffFileBlock = memo(DiffFileBlockImpl);
