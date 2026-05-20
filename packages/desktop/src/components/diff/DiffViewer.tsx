import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useTheme } from "@/hooks/useTheme";
import { DiffFileTree, type ChangedFileEntry } from "./DiffFileTree";
import { DiffContent } from "./DiffContent";
import { DiffLayout } from "./DiffLayout";
import type { CommentSide } from "./PatchDiffView";
import { DiffViewerBottomBar } from "./DiffViewerBottomBar";
import { useDiffData, type DiffMode } from "./useDiffData";
import { useDiffKeyboard } from "./useDiffKeyboard";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import type { DiffComment } from "./DiffCommentWidget";
import { useOpenDiffInEditor } from "./OpenDiffInEditorContext";

interface DiffViewerProps {
  featureId: number;
  mode: DiffMode;
  targetBranch?: string;
  /** Optional controlled file-list collapsed state. */
  fileListCollapsed?: boolean;
  onFileListCollapsedChange?: (collapsed: boolean) => void;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
}

const GIT_SIDEBAR_COLLAPSED_SETTING = "git_sidebar_collapsed";

export function DiffViewer({
  featureId,
  mode,
  targetBranch,
  fileListCollapsed,
  onFileListCollapsedChange,
  onOpenFileInEditor,
}: DiffViewerProps) {
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = onOpenFileInEditor ?? contextOpenFileInEditor;
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
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
  const data = useDiffData(featureId, mode, targetBranch);

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

  const scrollToFileIndex = useCallback(
    (index: number, behavior: ScrollBehavior = "smooth") => {
      const name = data.fileNames[index];
      if (!name) return;
      setSelectedFile(name);
      const el = diffAreaRef.current?.querySelector<HTMLElement>(
        `[data-file="${CSS.escape(name)}"]`,
      );
      el?.scrollIntoView({ behavior, block: "start" });
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
    return data.fileMeta.map(({ section, displayName, additions, deletions }) => {
      const status =
        section.oldFileName === "/dev/null" ? "A" : section.newFileName === "/dev/null" ? "D" : "M";
      return {
        file: displayName,
        status,
        additions,
        deletions,
        is_staged: data.stagedFiles.has(displayName),
      };
    });
  }, [data.fileMeta, data.stagedFiles]);

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
    requestAnimationFrame(() => {
      const el = diffAreaRef.current?.querySelector(`[data-file="${CSS.escape(filePath)}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

  const loadMoreCommits = useCallback((): void => {
    callbacksRef.current.data.setCommitLimit((l) => l + 20);
  }, []);

  const collapseFileList = useCallback((): void => {
    setFileListCollapsed(true);
  }, [setFileListCollapsed]);

  const diffContent = useMemo(
    () => (
      <DiffContent
        diffAreaRef={diffAreaRef}
        fileMeta={data.fileMeta}
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
      data.fileMeta,
      data.selectedCommit,
      data.viewedFilesSet,
      diffMode,
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
        commits={data.commits}
        selectedCommit={data.selectedCommit}
        onSelectCommit={data.setSelectedCommit}
        isOnBaseBranch={data.isOnBaseBranch}
        onLoadMoreCommits={loadMoreCommits}
        onCollapse={isControlled ? undefined : collapseFileList}
      />
    ),
    [
      changedFileEntries,
      collapseFileList,
      data.commits,
      data.isOnBaseBranch,
      data.selectedCommit,
      data.setSelectedCommit,
      data.viewedFilesSet,
      expandedFiles,
      handleSelectFile,
      isControlled,
      loadMoreCommits,
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

  if (!data.rawDiff?.trim()) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">No changes detected</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {data.selectedCommit &&
        (() => {
          const commit = data.commits.find((c) => c.sha === data.selectedCommit);
          return (
            <div className="border-b border-border px-4 py-2 text-sm text-foreground">
              <div className="flex items-center gap-3">
                <span className="font-mono text-primary">{data.selectedCommit.slice(0, 7)}</span>
                <span className="min-w-0 flex-1 text-foreground">{commit?.message}</span>
                <button
                  className="shrink-0 rounded bg-accent px-2 py-0.5 text-xs text-foreground hover:bg-muted-foreground"
                  onClick={() => data.setSelectedCommit(null)}
                >
                  Working Changes
                </button>
              </div>
              {commit?.body && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {commit.body}
                </p>
              )}
            </div>
          );
        })()}

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
        fileCount={data.fileMeta.length}
        diffMode={diffMode}
        onDiffModeChange={setDiffMode}
      />
    </div>
  );
}
