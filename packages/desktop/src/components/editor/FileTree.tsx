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
import { useEditorState } from "@/hooks/useEditorState";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useFileTreeMutations } from "@/hooks/useFileTreeMutations";
import { useFileTreeAgentShortcut } from "./useFileTreeAgentShortcut";
import {
  buildPierreInputs,
  CadencrFileTree,
  fromPierrePath,
  gitStatusFromUncommittedFiles,
  useCadencrFileTree,
} from "@/components/file-tree/CadencrFileTree";
import { revealInFileTree } from "@/components/file-tree/revealInFileTree";
import { useActiveFileHighlight } from "@/components/file-tree/useActiveFileHighlight";
import { FileTreeContextMenu } from "./FileTreeContextMenu";
import { copyFilePath } from "./copyFilePath";
import { mergeFileTreeEntries, useLazyIgnoredFileTreeEntries } from "./lazyIgnoredFileTreeEntries";
import { useTrackedTreeData } from "./useTrackedTreeData";
import { useFileTreeEntryActions } from "./useFileTreeEntryActions";
import { useFileTreeDraft, type DraftKind } from "./useFileTreeDraft";

interface FileTreeProps {
  projectId: number;
  featureId: number;
}

// Past this many tracked files, loading the whole tree up front (`tree-all`)
// is too slow on giant monorepos, so we switch to expand-on-demand for the
// whole tree. Below it, the instant full-tree behaviour is kept (no
// regression).
const TREE_LAZY_THRESHOLD = 5000;

/** Parent dir of an FS-form path; "" for top-level entries. */
function parentDirOf(fsPath: string): string {
  const idx = fsPath.lastIndexOf("/");
  return idx === -1 ? "" : fsPath.slice(0, idx);
}

/**
 * Editor file tree, backed by `@pierre/trees`. Pierre owns rendering,
 * virtualization, inline rename, drag-and-drop. We own data fetching
 * (`useTreeAll`), mutations (`useFileTreeMutations`), the context menu,
 * the inline-create draft (`useFileTreeDraft`), and tree-level
 * shortcuts (Enter = rename, ⌘⌫ = trash).
 */
export default function FileTree({ projectId, featureId }: FileTreeProps) {
  const { activePaneId, panes, openFile, renameFilePath } = useEditorState(featureId);
  const activeFilePath = panes[activePaneId]?.activeFilePath ?? null;
  const { value: maxTabsSetting } = useDebouncedSetting("editor_max_tabs");
  const maxTabs = useMemo(() => parseInt(maxTabsSetting ?? "10", 10), [maxTabsSetting]);

  // Hybrid threshold: cheaply count tracked files first; only repos past
  // `TREE_LAZY_THRESHOLD` switch to expand-on-demand for the whole tree.
  // While the count is in flight `lazyMode` stays false, so small repos paint
  // their full tree without waiting on the count.
  const treeCount = useTreeCount({
    project_id: projectId,
    feature_id: featureId,
    exclude_gitignored: true,
  });
  const lazyMode = (treeCount.data?.count ?? 0) > TREE_LAZY_THRESHOLD;

  const mutations = useFileTreeMutations(projectId, featureId, lazyMode);

  // ── Full-tree mode (small/medium repos) ───────────────────────────────
  // Fast recursive fetch for tracked files, disabled in lazy mode. Gitignored
  // directories are loaded lazily one level at a time by
  // `useLazyIgnoredFileTreeEntries` so common mutations don't trigger a huge
  // `node_modules`/`target` walk.
  const tracked = useTreeAll(
    { project_id: projectId, feature_id: featureId, exclude_gitignored: true },
    { query: { enabled: !lazyMode } },
  );
  const [lazyIgnoredEntries, setLazyIgnoredEntries] = useState<readonly FileTreeEntry[]>([]);
  const fullEntries = useMemo(
    () => mergeFileTreeEntries(tracked.data, lazyIgnoredEntries),
    [tracked.data, lazyIgnoredEntries],
  );

  // ── Lazy mode (giant repos) ───────────────────────────────────────────
  // Entries flow through this state (populated by `useTrackedTreeData` below,
  // after the model exists). Mirrors the gitignored loader's data flow so the
  // model dependency stays acyclic.
  const [trackedLazyEntries, setTrackedLazyEntries] = useState<readonly FileTreeEntry[]>([]);

  const entries = lazyMode ? trackedLazyEntries : fullEntries;
  // One pass to produce both the pierre `paths` array and the minimal set
  // of gitignored "roots" feeding `useGitignoredDimming`.
  const { paths, ignoredPathPrefixes } = useMemo(() => {
    if (entries == null) return EMPTY_INPUTS;
    const { paths: p, ignoredRoots } = buildPierreInputs(entries);
    return { paths: p, ignoredPathPrefixes: ignoredRoots };
  }, [entries]);

  // Live uncommitted-file statuses. WS git handler invalidates
  // `/api/git/uncommitted-files` on every `git.status` envelope; pierre
  // decorates changed rows and dots every ancestor folder. We deliberately
  // don't feed gitignored entries here — pierre's ancestor walk would dot
  // the project root via every `node_modules/` (see
  // `gitStatusFromUncommittedFiles`).
  const uncommitted = useGetUncommittedFiles({ feature_id: featureId });
  const gitStatus = useMemo(
    () => gitStatusFromUncommittedFiles(uncommitted.data),
    [uncommitted.data],
  );

  const { model } = useCadencrFileTree({
    paths,
    gitStatus,
    ignoredPathPrefixes,
    // Pierre's built-in search input is hidden — search is reached through
    // the global CMD+P file-picker (see `EditorFuzzyShortcut`).
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
    projectId,
    featureId,
    trackedEntries: tracked.data,
    onEntriesChange: setLazyIgnoredEntries,
    enabled: !lazyMode,
  });

  // Lazy-mode tree data (giant repos): loads the top level then expands
  // on-demand. Inert (no queries) when `enabled` is false. Entries flow into
  // `trackedLazyEntries` above.
  const lazyTree = useTrackedTreeData({
    model,
    projectId,
    featureId,
    enabled: lazyMode,
    onEntriesChange: setTrackedLazyEntries,
  });

  // Sticky `--primary` 28%-mix background on the editor-active file row
  // (DESIGN.md → EditorPanel "Explorer item active"). Separate from the
  // reveal effect below: reveal only fires when the active file CHANGES,
  // but the highlight has to stay applied as the user navigates around
  // the tree with the keyboard, and survive tree refetches.
  useActiveFileHighlight(model, activeFilePath);

  // Auto-reveal the active file in the tree: expand its ancestor folders,
  // scroll it into view, focus the row. Re-runs when `activeFilePath`
  // changes (tab switch / open) and when `paths` updates (so a newly
  // created file is revealed once the refetch lands). The ref guard means
  // a tree refetch does NOT re-expand folders the user manually collapsed
  // after the initial reveal.
  const lastRevealedRef = useRef<string | null>(null);
  const ensureDirLoaded = lazyTree.ensureDirLoaded;
  useEffect(() => {
    if (!activeFilePath) {
      lastRevealedRef.current = null;
      return;
    }
    if (lastRevealedRef.current === activeFilePath) return;
    // In lazy mode the file's ancestors may not be loaded yet; `revealInFileTree`
    // requests the chain (deduped) and we retry when `paths` next updates.
    if (revealInFileTree(model, activeFilePath, lazyMode ? ensureDirLoaded : undefined)) {
      lastRevealedRef.current = activeFilePath;
    }
  }, [model, activeFilePath, paths, lazyMode, ensureDirLoaded]);

  // ── Inline-create draft state (Pierre placeholder + rename) ────────────
  const onFileCreated = useCallback(
    (fsPath: string) => {
      openFile(activePaneId, fsPath, maxTabs);
    },
    [activePaneId, maxTabs, openFile],
  );
  const { startCreate, isDraftPath, tryHandleAsCreate } = useFileTreeDraft({
    model,
    projectId,
    featureId,
    mutations,
    onFileCreated,
    featureKey: featureId,
  });

  // Open files only on explicit click — pierre retargets `e.target` to
  // the shadow host, so `closest()` won't find the row. Walk
  // `composedPath()` (which crosses the shadow boundary) instead. Using
  // selection as the trigger conflated rename/move with file open.
  const handleTreeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const path = e.nativeEvent.composedPath();
      let row: HTMLElement | null = null;
      for (const node of path) {
        if (node instanceof HTMLElement && node.hasAttribute("data-item-path")) {
          row = node;
          break;
        }
      }
      if (!row) return;
      if (row.getAttribute("data-item-type") !== "file") return;
      const pierrePath = row.getAttribute("data-item-path");
      if (!pierrePath || isDraftPath(pierrePath)) return;
      openFile(activePaneId, fromPierrePath(pierrePath), maxTabs);
    },
    [activePaneId, isDraftPath, maxTabs, openFile],
  );

  // Rename / move / trash handlers (extracted to keep this file under the
  // size limit). Each issues its mutation and reconciles pierre's optimistic
  // model on error.
  const { handleRename, handleDropComplete, trashPath } = useFileTreeEntryActions({
    model,
    projectId,
    featureId,
    mutations,
    renameFilePath,
    tryHandleAsCreate,
  });

  // ── Context-menu actions ───────────────────────────────────────────────
  const handleMenuAction = useCallback(
    (
      action: "new-file" | "new-folder" | "open" | "copy-path" | "reveal" | "rename" | "delete",
      item: FileTreeContextMenuItem,
      context: FileTreeContextMenuOpenContext,
    ) => {
      const fsItemPath = fromPierrePath(item.path);
      switch (action) {
        case "new-file":
        case "new-folder": {
          const kind: DraftKind = action === "new-file" ? "file" : "folder";
          // For a directory: the new entry lands inside it. For a file: the
          // new entry lands next to it (in its parent dir).
          const parentDir = item.kind === "directory" ? fsItemPath : parentDirOf(fsItemPath);
          context.close({ restoreFocus: false });
          startCreate(kind, parentDir);
          return;
        }
        case "open":
          context.close();
          openFile(activePaneId, fsItemPath, maxTabs);
          return;
        case "copy-path":
          context.close();
          copyFilePath(fsItemPath);
          return;
        case "reveal":
          context.close();
          void mutations.reveal(fsItemPath);
          return;
        case "rename":
          context.close({ restoreFocus: false });
          model.startRenaming(item.path);
          return;
        case "delete":
          context.close();
          trashPath(item.path);
          return;
        default:
          return;
      }
    },
    [activePaneId, maxTabs, model, mutations, openFile, startCreate, trashPath],
  );

  const renderContextMenu = useCallback(
    (item: FileTreeContextMenuItem, context: FileTreeContextMenuOpenContext) => (
      <FileTreeContextMenu item={item} context={context} onAction={handleMenuAction} />
    ),
    [handleMenuAction],
  );

  // Tree-level shortcuts: Enter → rename focused row; ⌘⌫ → move to trash.
  // Pierre owns arrow keys, F2, etc.
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Skip when typing inside pierre's rename input / search box.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      // Skip while pierre's context menu is open; it owns the active
      // verb and would otherwise double-fire trash/rename through both
      // the menu row and this handler.
      if (document.querySelector("[data-file-tree-context-menu-root]")) return;
      const focusedPierrePath = model.getFocusedPath();
      if (!focusedPierrePath) return;
      // Pierre owns keys while the draft placeholder is being renamed.
      if (isDraftPath(focusedPierrePath)) return;

      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        model.startRenaming(focusedPierrePath);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
        e.preventDefault();
        trashPath(focusedPierrePath);
        return;
      }
    },
    [isDraftPath, model, trashPath],
  );

  // Pierre's shadow-root keydown swallows ⌘⇧A (its select-all matcher
  // ignores Shift), preventing the documented `pane-agent` shortcut from
  // ever reaching the document-level listener. Reinstate it locally.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useFileTreeAgentShortcut(containerRef, featureId);

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col"
      onKeyDown={handleTreeKeyDown}
      onClick={handleTreeClick}
    >
      <CadencrFileTree
        model={model}
        // Full mode: block only on the fast (`tracked`) query — gitignored
        // dirs upgrade the tree in place. Lazy mode: block on the top-level
        // load. The count query gates the choice but is too cheap to block on.
        isLoading={lazyMode ? lazyTree.isLoading : tracked.isLoading && !tracked.data}
        errorMessage={
          lazyMode
            ? lazyTree.error
            : tracked.isError && !tracked.data
              ? "Failed to load file tree"
              : null
        }
        renderContextMenu={renderContextMenu}
        aria-label="Project file tree"
      />
    </div>
  );
}

// Stable empty inputs so the memo doesn't churn while the queries are in
// flight (`useTreeAll().data` is `undefined` before the first response).
const EMPTY_INPUTS: { paths: readonly string[]; ignoredPathPrefixes: readonly string[] } = {
  paths: [],
  ignoredPathPrefixes: [],
};
