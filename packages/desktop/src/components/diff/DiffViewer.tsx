import { memo, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { GIT_DIFF_VIEW_MODE_KEY, parseGitDiffViewMode } from "@/lib/git-diff-view-mode";
import { useTheme } from "@/hooks/useTheme";
import { DiffFileTree, type ChangedFileEntry } from "./DiffFileTree";
import { DiffContent } from "./DiffContent";
import { DiffLayout } from "./DiffLayout";
import type { CommentSide } from "./PatchDiffView";
import { DiffViewerBottomBar } from "./DiffViewerBottomBar";
import { useDiffData, type DiffMode } from "./useDiffData";
import { useDiffKeyboard } from "./useDiffKeyboard";
import { useCollapseLargeFilesOnLoad } from "./useLargeFileCollapse";
import { scrollFileToTop } from "./scroll-to-file";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import type { DiffComment } from "./DiffCommentWidget";
import { useOpenDiffInEditor } from "./OpenDiffInEditorContext";

interface DiffViewerProps {
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  /**
   * When set, render the full diff of this single commit instead of the
   * working-tree / branch comparison. Drives the Git-tab Graph view's
   * click-to-open-commit flow.
   */
  commitSha?: string | null;
  /** Optional controlled file-list collapsed state. */
  fileListCollapsed?: boolean;
  onFileListCollapsedChange?: (collapsed: boolean) => void;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
}

const GIT_SIDEBAR_COLLAPSED_SETTING = "git_sidebar_collapsed";

function DiffViewerImpl({
  featureId,
  mode,
  targetBranch,
  commitSha,
  fileListCollapsed,
  onFileListCollapsedChange,
  onOpenFileInEditor,
}: DiffViewerProps) {
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = onOpenFileInEditor ?? contextOpenFileInEditor;
  const { value: persistedDiffMode, setValue: setDiffMode } = useDebouncedSetting(
    GIT_DIFF_VIEW_MODE_KEY,
    0,
  );
  const diffMode = parseGitDiffViewMode(persistedDiffMode);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [focusedFileIndex, setFocusedFileIndex] = useState(-1);
  const [activeCommentWidget, setActiveCommentWidget] = useState<{
    filePath: string;
    lineNumber: number;
    side: CommentSide;
  } | null>(null);
  const diffAreaRef = useRef<HTMLDivElement>(null);
  const isControlled = fileListCollapsed !== undefined;
  const {
    value: persistedFileListCollapsed,
    setValue: persistFileListCollapsed,
    isLoading: isFileListCollapseLoading,
  } = useDebouncedSetting(GIT_SIDEBAR_COLLAPSED_SETTING, 0);
  const isFileListCollapsed = isControlled
    ? !!fileListCollapsed
    : persistedFileListCollapsed === "true";
  const showFileListRail = isControlled
    ? isFileListCollapsed
    : isFileListCollapseLoading || isFileListCollapsed;

  const { theme } = useTheme();
  const data = useDiffData(featureId, mode, targetBranch, commitSha);

  const commentLinesByFile = useMemo(() => {
    const map = new Map<string, CommentLineData[]>();
    for (const c of data.comments as DiffComment[]) {
      const lines = map.get(c.file_path) ?? [];
      const existing = lines.find((l) => l.lineNumber === c.line_number);
      if (existing) {
        existing.comments.push(c);
      } else {
        lines.push({ lineNumber: c.line_number, comments: [c] });
      }
      map.set(c.file_path, lines);
    }
    return map;
  }, [data.comments]);

  const callbacksRef = useRef<{
    activeWidget: typeof activeCommentWidget;
    data: typeof data;
    featureId: number;
  }>({
    activeWidget: activeCommentWidget,
    data,
    featureId,
  });
  callbacksRef.current = { activeWidget: activeCommentWidget, data, featureId };

  const handleAddComment = useCallback(
    (filePath: string, lineNumber: number, side: CommentSide = "new") =>
      setActiveCommentWidget({ filePath, lineNumber, side }),
    [],
  );

  const memoizedActiveWidget = useMemo<ActiveWidget | null>(
    () =>
      activeCommentWidget
        ? { lineNumber: activeCommentWidget.lineNumber, side: activeCommentWidget.side }
        : null,
    [activeCommentWidget],
  );

  const stableCallbacks = useMemo<CommentCallbacks>(
    () => ({
      onSubmit: (lineNumber: number, content: string) => {
        const { activeWidget, data: d, featureId: currentFeatureId } = callbacksRef.current;
        if (!activeWidget || !content) {
          return;
        }
        d.createComment.mutate({
          featureId: currentFeatureId,
          data: {
            feature_id: currentFeatureId,
            file_path: activeWidget.filePath,
            line_number: lineNumber,
            side: activeWidget.side,
            content,
            // Snapshotted so `useDiffData`'s auto-invalidation can drop this
            // comment if the file changes before it's sent.
            original_blob_sha: d.blobShas[activeWidget.filePath] ?? null,
          },
        });
        setActiveCommentWidget(null);
      },
      onClose: () => setActiveCommentWidget(null),
      onEdit: (id: number, content: string) =>
        callbacksRef.current.data.updateComment.mutate({ id, data: { content } }),
      onDelete: (id: number) => callbacksRef.current.data.deleteComment.mutate({ id }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [],
  );

  useEffect(() => {
    if (!data.hasInitializedCollapse.current && data.viewedFilesSet.size > 0) {
      data.hasInitializedCollapse.current = true;
      setCollapsedFiles((prev) => new Set([...prev, ...data.viewedFilesSet]));
    }
  }, [data.viewedFilesSet, data.hasInitializedCollapse]);

  useCollapseLargeFilesOnLoad(data.changedFiles, setCollapsedFiles);

  const scrollToFileIndex = useCallback(
    (index: number) => {
      const name = data.fileNames[index];
      if (!name) return;
      setSelectedFile(name);
      const container = diffAreaRef.current;
      if (container) scrollFileToTop(container, name);
    },
    [data.fileNames],
  );

  const toggleFile = useCallback((fileName: string) => {
    setSelectedFile(fileName);
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }, []);
  const markFileViewed = useCallback((fileName: string) => {
    const { data: currentData, featureId: currentFeatureId } = callbacksRef.current;
    currentData.markViewed.mutate({
      featureId: currentFeatureId,
      data: {
        feature_id: currentFeatureId,
        file_path: fileName,
        blob_sha: currentData.blobShas[fileName] ?? "",
      },
    });
    setCollapsedFiles((prev) => new Set([...prev, fileName]));
  }, []);
  const unmarkFileViewed = useCallback((fileName: string) => {
    const { data: currentData, featureId: currentFeatureId } = callbacksRef.current;
    currentData.unmarkViewed.mutate({
      featureId: currentFeatureId,
      params: { file_path: fileName },
    });
  }, []);

  useDiffKeyboard({
    fileNames: data.fileNames,
    focusedFileIndex,
    setFocusedFileIndex,
    scrollToFileIndex,
    toggleFile,
    blobShas: data.blobShas,
    viewedFilesSet: data.viewedFilesSet,
    markViewed: data.markViewed,
    unmarkViewed: data.unmarkViewed,
    featureId,
    diffAreaRef,
    setCollapsedFiles,
    onOpenFocusedFileInEditor: openFileInEditor,
  });

  const changedFileEntries: ChangedFileEntry[] = useMemo(() => {
    return data.changedFiles.map((f) => ({
      file: f.file,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      is_staged: data.stagedFiles.has(f.file),
    }));
  }, [data.changedFiles, data.stagedFiles]);

  const expandedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const e of changedFileEntries) {
      if (!collapsedFiles.has(e.file)) set.add(e.file);
    }
    return set;
  }, [changedFileEntries, collapsedFiles]);

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFile(filePath);
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
    const container = diffAreaRef.current;
    if (container) scrollFileToTop(container, filePath);
  }, []);

  const setFileListCollapsed = useCallback(
    (collapsed: boolean): void => {
      if (isControlled) {
        onFileListCollapsedChange?.(collapsed);
        return;
      }
      persistFileListCollapsed(String(collapsed));
    },
    [isControlled, onFileListCollapsedChange, persistFileListCollapsed],
  );

  const collapseFileList = useCallback((): void => {
    setFileListCollapsed(true);
  }, [setFileListCollapsed]);

  const diffContent = useMemo(
    () => (
      <DiffContent
        diffAreaRef={diffAreaRef}
        files={data.changedFiles}
        featureId={featureId}
        mode={mode}
        targetBranch={targetBranch}
        selectedCommit={data.selectedCommit}
        diffMode={diffMode}
        collapsedFiles={collapsedFiles}
        focusedFileIndex={focusedFileIndex}
        viewedFilesSet={data.viewedFilesSet}
        commentLinesByFile={commentLinesByFile}
        activeCommentWidget={activeCommentWidget}
        memoizedActiveWidget={memoizedActiveWidget}
        commentCallbacks={stableCallbacks}
        onToggleFile={toggleFile}
        onMarkViewedFile={markFileViewed}
        onUnmarkViewedFile={unmarkFileViewed}
        onOpenFileInEditor={openFileInEditor}
        onAddComment={handleAddComment}
        themeAppearance={theme.appearance}
        themeId={theme.id}
      />
    ),
    [
      activeCommentWidget,
      collapsedFiles,
      commentLinesByFile,
      data.changedFiles,
      data.selectedCommit,
      data.viewedFilesSet,
      diffMode,
      featureId,
      mode,
      targetBranch,
      focusedFileIndex,
      handleAddComment,
      markFileViewed,
      memoizedActiveWidget,
      openFileInEditor,
      stableCallbacks,
      theme.appearance,
      theme.id,
      toggleFile,
      unmarkFileViewed,
    ],
  );

  const fileTree = useMemo(
    () => (
      <DiffFileTree
        files={changedFileEntries}
        expandedFiles={expandedFiles}
        selectedFile={selectedFile}
        viewedFiles={data.viewedFilesSet}
        onToggleExpand={toggleFile}
        onSelectFile={handleSelectFile}
        onCollapse={isControlled ? undefined : collapseFileList}
      />
    ),
    [
      changedFileEntries,
      collapseFileList,
      data.viewedFilesSet,
      expandedFiles,
      handleSelectFile,
      isControlled,
      selectedFile,
      toggleFile,
    ],
  );

  if (data.isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">Loading diff...</p>
      </div>
    );
  }

  if (data.changedFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">No changes detected</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <DiffLayout
        collapsed={showFileListRail}
        controlled={isControlled}
        disabled={isFileListCollapseLoading}
        sidebar={fileTree}
        content={diffContent}
        onCollapsedChange={setFileListCollapsed}
      />

      <DiffViewerBottomBar
        viewedCount={data.viewedFilesSet.size}
        fileCount={data.changedFiles.length}
        diffMode={diffMode}
        onDiffModeChange={setDiffMode}
      />
    </div>
  );
}

// The Git panel is mounted beside a streaming agent. Parent toolbar/badge
// updates must not make the diff tree render again; its own React Query hooks
// still update it immediately when changed-files or a per-file patch changes.
export const DiffViewer = memo(DiffViewerImpl);
