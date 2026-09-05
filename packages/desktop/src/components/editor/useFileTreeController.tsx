import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext,
  FileTreeRenameEvent,
} from "@pierre/trees";
import {
  useGetUncommittedFiles,
  useTreeAll,
  useTreeCount,
  type FileTreeEntry,
} from "@/api/generated";
import {
  buildPierreInputs,
  fromPierrePath,
  gitStatusFromUncommittedFiles,
  useCadencrFileTree,
} from "@/components/file-tree/CadencrFileTree";
import { revealInFileTree } from "@/components/file-tree/revealInFileTree";
import { useActiveFileHighlight } from "@/components/file-tree/useActiveFileHighlight";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useEditorState } from "@/hooks/useEditorState";
import { useFileTreeMutations } from "@/hooks/useFileTreeMutations";
import { copyFilePath } from "./copyFilePath";
import { FileTreeContextMenu } from "./FileTreeContextMenu";
import { getFileTreeLoadState, shouldFetchFullTree, shouldUseLazyTree } from "./fileTreeLoadMode";
import { mergeFileTreeEntries, useLazyIgnoredFileTreeEntries } from "./lazyIgnoredFileTreeEntries";
import { useFileTreeAgentShortcut } from "./useFileTreeAgentShortcut";
import { useFileTreeDraft, type DraftKind } from "./useFileTreeDraft";
import { useFileTreeEntryActions } from "./useFileTreeEntryActions";
import { type OpenInNeovim, useOpenFileInNeovim } from "./neovim/useOpenFileInNeovim";
import { useTrackedTreeData } from "./useTrackedTreeData";

export interface FileTreeProps {
  projectId: number;
  featureId: number;
}

const TREE_LAZY_THRESHOLD = 5000;
const EMPTY_INPUTS: { paths: readonly string[]; ignoredPathPrefixes: readonly string[] } = {
  paths: [],
  ignoredPathPrefixes: [],
};

function parentDirOf(fsPath: string): string {
  const index = fsPath.lastIndexOf("/");
  return index === -1 ? "" : fsPath.slice(0, index);
}

function useFileTreeData(projectId: number, featureId: number) {
  const treeCount = useTreeCount({
    project_id: projectId,
    feature_id: featureId,
    exclude_gitignored: true,
  });
  const lazyMode = shouldUseLazyTree(treeCount.data?.count, TREE_LAZY_THRESHOLD);
  const fullTreeEnabled = shouldFetchFullTree({
    count: treeCount.data?.count,
    isCountResolved: treeCount.isSuccess,
    threshold: TREE_LAZY_THRESHOLD,
  });
  const tracked = useTreeAll(
    { project_id: projectId, feature_id: featureId, exclude_gitignored: true },
    { query: { enabled: fullTreeEnabled } },
  );
  const [lazyIgnoredEntries, setLazyIgnoredEntries] = useState<readonly FileTreeEntry[]>([]);
  const [trackedLazyEntries, setTrackedLazyEntries] = useState<readonly FileTreeEntry[]>([]);
  const fullEntries = useMemo(
    () => mergeFileTreeEntries(tracked.data, lazyIgnoredEntries),
    [lazyIgnoredEntries, tracked.data],
  );
  const entries = lazyMode ? trackedLazyEntries : fullEntries;
  const { paths, ignoredPathPrefixes } = useMemo(() => {
    if (entries == null) return EMPTY_INPUTS;
    const { paths: pierrePaths, ignoredRoots } = buildPierreInputs(entries);
    return { paths: pierrePaths, ignoredPathPrefixes: ignoredRoots };
  }, [entries]);
  const uncommitted = useGetUncommittedFiles({ feature_id: featureId });
  const gitStatus = useMemo(
    () => gitStatusFromUncommittedFiles(uncommitted.data),
    [uncommitted.data],
  );
  return {
    gitStatus,
    ignoredPathPrefixes,
    lazyMode,
    paths,
    setLazyIgnoredEntries,
    setTrackedLazyEntries,
    tracked,
    treeCount,
  };
}

type FileTreeData = ReturnType<typeof useFileTreeData>;
type EditorState = ReturnType<typeof useEditorState>;

function useFileTreeModel(
  props: FileTreeProps,
  data: FileTreeData,
  editor: EditorState,
  maxTabs: number,
  openInNeovim: OpenInNeovim | undefined,
) {
  const mutations = useFileTreeMutations(props.projectId, props.featureId, data.lazyMode);
  const { model } = useCadencrFileTree({
    paths: data.paths,
    gitStatus: data.gitStatus,
    ignoredPathPrefixes: data.ignoredPathPrefixes,
    search: false,
    fileTreeSearchMode: "expand-matches",
    renaming: {
      canRename: (item: { path: string }) => item.path !== "",
      onError: (message: string) => toast.error(message),
      onRename: (event: FileTreeRenameEvent) => handleRename(event),
    },
    dragAndDrop: {
      canDrag: (selected: readonly string[]) => selected.length > 0,
      canDrop: ({ target }: { target: { kind: string } }) =>
        target.kind === "directory" || target.kind === "root",
      onDropComplete: (event: {
        draggedPaths: readonly string[];
        target: { directoryPath: string | null };
      }) => handleDropComplete(event.draggedPaths, event.target.directoryPath),
      onDropError: (message: string) => toast.error(message),
    },
  });
  useLazyIgnoredFileTreeEntries({
    model,
    projectId: props.projectId,
    featureId: props.featureId,
    trackedEntries: data.tracked.data,
    onEntriesChange: data.setLazyIgnoredEntries,
    enabled: !data.lazyMode,
  });
  const lazyTree = useTrackedTreeData({
    model,
    projectId: props.projectId,
    featureId: props.featureId,
    enabled: data.lazyMode,
    onEntriesChange: data.setTrackedLazyEntries,
  });
  const onFileCreated = useCallback(
    (fsPath: string) => {
      if (openInNeovim) {
        openInNeovim(fsPath);
      } else {
        editor.openFile(editor.activePaneId, fsPath, maxTabs);
      }
    },
    [editor.activePaneId, editor.openFile, maxTabs, openInNeovim],
  );
  const draft = useFileTreeDraft({
    model,
    projectId: props.projectId,
    featureId: props.featureId,
    mutations,
    onFileCreated,
    featureKey: props.featureId,
  });
  const { handleRename, handleDropComplete, trashPath } = useFileTreeEntryActions({
    model,
    projectId: props.projectId,
    featureId: props.featureId,
    mutations,
    renameFilePath: editor.renameFilePath,
    tryHandleAsCreate: draft.tryHandleAsCreate,
  });
  return { draft, lazyTree, model, mutations, trashPath };
}

type FileTreeModelState = ReturnType<typeof useFileTreeModel>;

function useActiveFileReveal(
  modelState: FileTreeModelState,
  data: FileTreeData,
  activeFilePath: string | null,
) {
  useActiveFileHighlight(modelState.model, activeFilePath);
  const lastRevealedRef = useRef<string | null>(null);
  const ensureDirLoaded = modelState.lazyTree.ensureDirLoaded;
  useEffect(() => {
    if (!activeFilePath) {
      lastRevealedRef.current = null;
      return;
    }
    if (lastRevealedRef.current === activeFilePath) return;
    if (
      revealInFileTree(
        modelState.model,
        activeFilePath,
        data.lazyMode ? ensureDirLoaded : undefined,
      )
    ) {
      lastRevealedRef.current = activeFilePath;
    }
  }, [activeFilePath, data.lazyMode, data.paths, ensureDirLoaded, modelState.model]);
}

function useFileTreeMenu(
  editor: EditorState,
  modelState: FileTreeModelState,
  maxTabs: number,
  openInNeovim: OpenInNeovim | undefined,
) {
  const handleAction = useCallback(
    (
      action: "new-file" | "new-folder" | "open" | "copy-path" | "reveal" | "rename" | "delete",
      item: FileTreeContextMenuItem,
      context: FileTreeContextMenuOpenContext,
    ): void => {
      const fsItemPath = fromPierrePath(item.path);
      if (action === "new-file" || action === "new-folder") {
        const kind: DraftKind = action === "new-file" ? "file" : "folder";
        const parentDir = item.kind === "directory" ? fsItemPath : parentDirOf(fsItemPath);
        context.close({ restoreFocus: false });
        modelState.draft.startCreate(kind, parentDir);
      } else if (action === "open") {
        context.close();
        if (openInNeovim) {
          openInNeovim(fsItemPath);
        } else {
          editor.openFile(editor.activePaneId, fsItemPath, maxTabs);
        }
      } else if (action === "copy-path") {
        context.close();
        copyFilePath(fsItemPath);
      } else if (action === "reveal") {
        context.close();
        void modelState.mutations.reveal(fsItemPath);
      } else if (action === "rename") {
        context.close({ restoreFocus: false });
        modelState.model.startRenaming(item.path);
      } else if (action === "delete") {
        context.close();
        modelState.trashPath(item.path);
      }
    },
    [editor, maxTabs, modelState, openInNeovim],
  );
  return useCallback(
    (item: FileTreeContextMenuItem, context: FileTreeContextMenuOpenContext) => (
      <FileTreeContextMenu item={item} context={context} onAction={handleAction} />
    ),
    [handleAction],
  );
}

function useFileTreeClick(
  editor: EditorState,
  modelState: FileTreeModelState,
  maxTabs: number,
  openInNeovim: OpenInNeovim | undefined,
) {
  return useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || event.defaultPrevented) return;
      let row: HTMLElement | null = null;
      for (const node of event.nativeEvent.composedPath()) {
        if (node instanceof HTMLElement && node.hasAttribute("data-item-path")) {
          row = node;
          break;
        }
      }
      if (!row || row.getAttribute("data-item-type") !== "file") return;
      const pierrePath = row.getAttribute("data-item-path");
      if (!pierrePath || modelState.draft.isDraftPath(pierrePath)) return;
      const fsPath = fromPierrePath(pierrePath);
      if (openInNeovim) {
        openInNeovim(fsPath);
      } else {
        editor.openFile(editor.activePaneId, fsPath, maxTabs);
      }
    },
    [editor, maxTabs, modelState.draft, openInNeovim],
  );
}

function useFileTreeKeyboard(modelState: FileTreeModelState) {
  return useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (document.querySelector("[data-file-tree-context-menu-root]")) return;
      const focusedPath = modelState.model.getFocusedPath();
      if (!focusedPath || modelState.draft.isDraftPath(focusedPath)) return;
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        modelState.model.startRenaming(focusedPath);
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") {
        event.preventDefault();
        modelState.trashPath(focusedPath);
      }
    },
    [modelState],
  );
}

export function useFileTreeController(props: FileTreeProps) {
  const editor = useEditorState(props.featureId);
  const activeFilePath = editor.panes[editor.activePaneId]?.activeFilePath ?? null;
  const { value: maxTabsSetting } = useDebouncedSetting("editor_max_tabs");
  const maxTabs = useMemo(() => parseInt(maxTabsSetting ?? "10", 10), [maxTabsSetting]);
  const data = useFileTreeData(props.projectId, props.featureId);
  const openInNeovim = useOpenFileInNeovim(props.featureId);
  const modelState = useFileTreeModel(props, data, editor, maxTabs, openInNeovim);
  useActiveFileReveal(modelState, data, activeFilePath);
  const renderContextMenu = useFileTreeMenu(editor, modelState, maxTabs, openInNeovim);
  const handleClick = useFileTreeClick(editor, modelState, maxTabs, openInNeovim);
  const handleKeyDown = useFileTreeKeyboard(modelState);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFileTreeAgentShortcut(containerRef, props.featureId);
  const loadState = getFileTreeLoadState({
    lazyMode: data.lazyMode,
    countIsPending: data.treeCount.isLoading,
    countIsError: data.treeCount.isError,
    lazyTreeIsLoading: modelState.lazyTree.isLoading,
    trackedIsLoading: data.tracked.isLoading,
    trackedHasData: data.tracked.data != null,
    countError: data.treeCount.error,
    lazyTreeError: modelState.lazyTree.error,
    trackedError: data.tracked.error,
    trackedIsError: data.tracked.isError,
  });
  return {
    containerRef,
    errorMessage: loadState.errorMessage,
    handleClick,
    handleKeyDown,
    isLoading: loadState.isLoading,
    model: modelState.model,
    renderContextMenu,
  };
}
