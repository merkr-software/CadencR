import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactNode } from "react";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { type FileDiffSection, hasTextHunks, isBinaryPatch } from "@/lib/parse-unified-diff";
import type { PrThreadLine } from "@/lib/pr-review-threads";
import { LARGE_DIFF_BYTES, isLargeDiffByLines } from "@/lib/diff-thresholds";
import { isImageFile } from "@/lib/file-language";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import { LargeDiffPlaceholder } from "./LargeDiffPlaceholder";
import { PatchDiffView, type CommentSide } from "./PatchDiffView";
import { ProgressiveLargeDiff } from "./ProgressiveLargeDiff";
import type { DiffMode } from "./useDiffData";
import { DiffImageView } from "./DiffImageView";

/** One-line status row under a file header (loading / error / no-hunks). */
export function DiffFileNotice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: ReactNode;
}) {
  return (
    <div
      className={`border-t border-border bg-[var(--editor-bg)] px-4 py-3 font-mono text-xs ${
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {children}
    </div>
  );
}

interface DiffFileBodyProps {
  featureId: number;
  displayName: string;
  oldFile?: string;
  status: string;
  mode: DiffMode;
  targetBranch?: string;
  commitSha?: string | null;
  section: FileDiffSection;
  patch: string;
  diffMode: "unified" | "split";
  additions: number;
  deletions: number;
  commentLines?: CommentLineData[];
  remoteThreadLines?: PrThreadLine[];
  activeReviewThreadId?: string | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  activeWidget?: ActiveWidget | null;
  commentCallbacks?: CommentCallbacks;
  onAddLineComment?: (lineNumber: number, side: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
  isFocused: boolean;
}

/** Body of an expanded file: binary/no-hunk/large placeholders or the diff. */
function DiffFileBodyImpl({
  featureId,
  displayName,
  oldFile,
  status,
  mode,
  targetBranch,
  commitSha,
  section,
  patch,
  diffMode,
  additions,
  deletions,
  commentLines,
  remoteThreadLines,
  activeReviewThreadId,
  selectedReviewThreadIds,
  onReviewThreadSelectedChange,
  activeWidget,
  commentCallbacks,
  onAddLineComment,
  themeAppearance,
  themeId,
  isFocused,
}: DiffFileBodyProps) {
  const { t } = useUiTranslation();
  const hasHunks = hasTextHunks(section);
  const isBinary = !hasHunks && isBinaryPatch(patch);
  const isLarge =
    hasHunks &&
    !isBinary &&
    (isLargeDiffByLines(additions, deletions) || patch.length >= LARGE_DIFF_BYTES);

  if (isBinary) {
    if (isImageFile(displayName)) {
      return (
        <DiffImageView
          featureId={featureId}
          filePath={displayName}
          oldFilePath={oldFile}
          status={status}
          mode={mode}
          targetBranch={targetBranch}
          commitSha={commitSha}
        />
      );
    }
    return (
      <LargeDiffPlaceholder
        variant="binary"
        sizeBytes={0}
        additions={additions}
        deletions={deletions}
      />
    );
  }
  if (!hasHunks) {
    return (
      <DiffFileNotice>
        {t(
          "workspace.git.diffFileBody.noTextHunksInThisFileDiff",
          "No text hunks in this file diff.",
        )}
      </DiffFileNotice>
    );
  }
  // Large opted-in files render chunk-by-chunk so even a multi-MB single-hunk
  // patch never blocks the main thread.
  const DiffBody = isLarge ? ProgressiveLargeDiff : PatchDiffView;
  return (
    <DiffBody
      patch={patch}
      mode={diffMode}
      commentLines={commentLines}
      remoteThreadLines={remoteThreadLines}
      activeReviewThreadId={activeReviewThreadId}
      selectedReviewThreadIds={selectedReviewThreadIds}
      onReviewThreadSelectedChange={onReviewThreadSelectedChange}
      activeWidget={activeWidget}
      commentCallbacks={commentCallbacks}
      themeAppearance={themeAppearance}
      themeId={themeId}
      focused={isFocused}
      disableFileHeader
      onAddComment={onAddLineComment}
    />
  );
}

export const DiffFileBody = memo(DiffFileBodyImpl);
