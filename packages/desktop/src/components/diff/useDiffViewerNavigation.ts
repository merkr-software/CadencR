import type { ChangedFile } from "@/api/generated";
import { FileStageState } from "@/api/generated";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import {
  resolvedStageState,
  useGitDiffFileTreeModel,
  type GitDiffTreeNavigationAdapter,
} from "./useGitDiffFileTreeModel";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useDiffData } from "./useDiffData";
import { useScannableSelection } from "./useDiffSelectionActions";
import { useFileCollapseState } from "./useLargeFileCollapse";
import { scrollFileToTop } from "./scroll-to-file";
import { openGitFileInEditor } from "./gitFileEditorHandoff";
import type { GitNavigationAdapterRegistrar, GitNavigationAdapter } from "./gitNavigation";

type DiffData = ReturnType<typeof useDiffData>;

interface UseDiffViewerNavigationOptions {
  featureId: number;
  data: DiffData;
  indexActions: GitFileIndexActions;
  diffAreaRef: RefObject<HTMLDivElement | null>;
  onOpenFileInEditor?: (filePath: string) => void;
  indexMutable: boolean;
  reviewCountsByFile?: ReadonlyMap<string, number>;
  registerNavigationAdapter?: GitNavigationAdapterRegistrar;
}

export interface DiffViewerNavigationState {
  tree: ReturnType<typeof useGitDiffFileTreeModel>;
  collapsedFiles: ReadonlySet<string>;
  expandedFiles: Set<string>;
  activeFilePath: string | null;
  revealFile: (filePath: string) => void;
  cancelRevealScroll: () => void;
  toggleFile: (filePath: string) => void;
  markFileViewed: (filePath: string) => void;
  unmarkFileViewed: (filePath: string) => void;
}

interface DiffNavigationAdapterState {
  tree: GitDiffTreeNavigationAdapter;
  collapsedFiles: ReadonlySet<string>;
  fileByPath: ReadonlyMap<string, ChangedFile>;
  viewedFiles: ReadonlySet<string>;
  viewedPending: boolean;
  viewedSupported: boolean;
  indexActions: GitFileIndexActions;
  indexMutable: boolean;
  diffAreaRef: RefObject<HTMLDivElement | null>;
  revealFile: (filePath: string) => void;
  scrollToFile: (filePath: string) => void;
  scanSelection: <T>(run: () => T) => T;
  collapseFile: (filePath: string) => void;
  markFileViewed: (filePath: string) => void;
  unmarkFileViewed: (filePath: string) => void;
  openFileInEditor?: (filePath: string) => void;
}

function runIndexAction(state: DiffNavigationAdapterState, action: "stage" | "reset"): boolean {
  if (!state.indexMutable || state.indexActions.isPending) return false;
  const path = state.tree.getActivePath();
  const file = path ? state.fileByPath.get(path) : undefined;
  if (!file) return false;
  const stageState = resolvedStageState(file);
  const availability = getGitFileActionAvailability(stageState);
  if (action === "stage" && availability.canStage) {
    state.indexActions.stage(file.file, {
      conflicted: stageState === FileStageState.conflicted,
    });
  } else if (action === "reset" && availability.canReset) state.indexActions.reset(file.file);
  else return false;
  return true;
}

function useDiffNavigationAdapter(state: DiffNavigationAdapterState): GitNavigationAdapter {
  const stateRef = useRef(state);
  stateRef.current = state;
  return useMemo<GitNavigationAdapter>(
    () => ({
      getActiveItem: () => stateRef.current.tree.getActivePath(),
      // Moving is a scan, not an open: the diff scrolls to the file but its
      // collapsed state is left exactly as the user set it. `l` opens.
      moveSelection: (offset) => {
        const current = stateRef.current;
        // The scroll comes from the selection listener inside `scanSelection`,
        // which pierre fires synchronously. Scrolling again here would cancel
        // the animation it just started and re-register the same one. The one
        // case the listener misses is a clamped move at either end, where the
        // path does not change and so nothing is re-selected.
        const before = current.tree.getActivePath();
        const path = current.scanSelection(() => current.tree.moveSelection(offset));
        if (!path) return false;
        if (path === before) current.scrollToFile(path);
        return true;
      },
      open: () => {
        const current = stateRef.current;
        const path = current.tree.getActivePath();
        if (!path) return false;
        current.revealFile(path);
        return true;
      },
      back: () => {
        const current = stateRef.current;
        const path = current.tree.getActivePath();
        if (!path) return false;
        if (!current.collapsedFiles.has(path)) current.collapseFile(path);
        else return current.tree.focusActive();
        return true;
      },
      toggleViewed: () => {
        const current = stateRef.current;
        const path = current.tree.getActivePath();
        if (!path || !current.viewedSupported || current.viewedPending) return false;
        if (current.viewedFiles.has(path)) current.unmarkFileViewed(path);
        else current.markFileViewed(path);
        return true;
      },
      stage: () => runIndexAction(stateRef.current, "stage"),
      reset: () => runIndexAction(stateRef.current, "reset"),
      scrollHalfPage: (direction) => {
        const area = stateRef.current.diffAreaRef.current;
        if (!area) return false;
        area.scrollBy({ top: direction * (area.clientHeight / 2), behavior: "smooth" });
        return true;
      },
      openInEditor: () => {
        const current = stateRef.current;
        const path = current.tree.getActivePath();
        if (!path || !current.openFileInEditor) return false;
        current.openFileInEditor(path);
        return true;
      },
    }),
    [],
  );
}

function useViewedFileActions(
  featureId: number,
  data: DiffData,
  collapseFile: (filePath: string) => void,
) {
  const stateRef = useRef({ data, featureId });
  stateRef.current = { data, featureId };
  const markFileViewed = useCallback(
    (filePath: string): void => {
      const current = stateRef.current;
      current.data.markViewed.mutate({
        featureId: current.featureId,
        data: {
          feature_id: current.featureId,
          file_path: filePath,
          blob_sha: current.data.blobShas[filePath] ?? "",
        },
      });
      collapseFile(filePath);
    },
    [collapseFile],
  );
  const unmarkFileViewed = useCallback((filePath: string): void => {
    const current = stateRef.current;
    current.data.unmarkViewed.mutate({
      featureId: current.featureId,
      params: { file_path: filePath },
    });
  }, []);
  return useMemo(() => ({ markFileViewed, unmarkFileViewed }), [markFileViewed, unmarkFileViewed]);
}

function useExpandedFiles(data: DiffData, collapsedFiles: ReadonlySet<string>): Set<string> {
  return useMemo(() => {
    const expanded = new Set<string>();
    for (const file of data.changedFiles) {
      if (!collapsedFiles.has(file.file)) expanded.add(file.file);
    }
    return expanded;
  }, [collapsedFiles, data.changedFiles]);
}

function useViewedCollapseInitialization(
  data: DiffData,
  collapseFiles: (filePaths: Iterable<string>) => void,
): void {
  useEffect(() => {
    if (data.hasInitializedCollapse.current || data.viewedFilesSet.size === 0) return;
    data.hasInitializedCollapse.current = true;
    collapseFiles(data.viewedFilesSet);
  }, [collapseFiles, data.hasInitializedCollapse, data.viewedFilesSet]);
}

function useFocusedFileEditorOpener(
  fileByPath: ReadonlyMap<string, ChangedFile>,
  onOpenFileInEditor: ((filePath: string) => void) | undefined,
): (filePath: string) => void {
  return useCallback(
    (filePath: string): void => {
      const file = fileByPath.get(filePath);
      if (file && onOpenFileInEditor) {
        openGitFileInEditor(file, () => onOpenFileInEditor(filePath));
      }
    },
    [fileByPath, onOpenFileInEditor],
  );
}

interface FileReveal {
  /** Bring a file into view and open it — the answer to a click or `l`. */
  revealFile: (filePath: string) => void;
  /** Bring a file into view and leave its collapsed state alone. */
  scrollToFile: (filePath: string) => void;
  cancelRevealScroll: () => void;
}

function useFileReveal(
  diffAreaRef: RefObject<HTMLDivElement | null>,
  expandFile: (filePath: string) => void,
): FileReveal {
  const cancelRevealScrollRef = useRef<() => void>(() => {});
  const cancelRevealScroll = useCallback((): void => cancelRevealScrollRef.current(), []);
  const scrollToFile = useCallback(
    (filePath: string): void => {
      cancelRevealScroll();
      if (diffAreaRef.current) {
        cancelRevealScrollRef.current = scrollFileToTop(diffAreaRef.current, filePath);
      }
    },
    [cancelRevealScroll, diffAreaRef],
  );
  const revealFile = useCallback(
    (filePath: string): void => {
      expandFile(filePath);
      scrollToFile(filePath);
    },
    [expandFile, scrollToFile],
  );
  useEffect(() => cancelRevealScroll, [cancelRevealScroll]);
  return useMemo(
    () => ({ revealFile, scrollToFile, cancelRevealScroll }),
    [cancelRevealScroll, revealFile, scrollToFile],
  );
}

export function useDiffViewerNavigation({
  featureId,
  data,
  indexActions,
  diffAreaRef,
  onOpenFileInEditor,
  indexMutable,
  reviewCountsByFile,
  registerNavigationAdapter,
}: UseDiffViewerNavigationOptions): DiffViewerNavigationState {
  const {
    collapsedFiles,
    collapseFile,
    collapseFiles,
    expandFile,
    toggleFile: toggleRawFile,
  } = useFileCollapseState(data.changedFiles);
  const { revealFile, scrollToFile, cancelRevealScroll } = useFileReveal(diffAreaRef, expandFile);
  const { scanSelection, handleTreeSelection } = useScannableSelection(revealFile, scrollToFile);
  const tree = useGitDiffFileTreeModel({
    files: data.changedFiles,
    onSelectionChange: handleTreeSelection,
    reviewCountsByFile,
  });
  useViewedCollapseInitialization(data, collapseFiles);
  const fileByPath = useMemo(
    () => new Map(data.changedFiles.map((file) => [file.file, file])),
    [data.changedFiles],
  );
  const openFocusedFileInEditor = useFocusedFileEditorOpener(fileByPath, onOpenFileInEditor);

  const toggleFile = useCallback(
    (filePath: string): void => {
      // Scanned, not revealed: letting the selection open the file first would
      // queue an expand ahead of this toggle, so collapsing worked and
      // expanding cancelled itself out.
      scanSelection(() => tree.navigation.selectPath(filePath));
      toggleRawFile(filePath);
    },
    [scanSelection, toggleRawFile, tree.navigation],
  );
  const { markFileViewed, unmarkFileViewed } = useViewedFileActions(featureId, data, collapseFile);

  const expandedFiles = useExpandedFiles(data, collapsedFiles);
  const adapter = useDiffNavigationAdapter({
    tree: tree.navigation,
    collapsedFiles,
    fileByPath,
    viewedFiles: data.viewedFilesSet,
    viewedPending: data.markViewed.isPending || data.unmarkViewed.isPending,
    viewedSupported: data.selectedCommit === null,
    indexActions,
    indexMutable,
    diffAreaRef,
    revealFile,
    scrollToFile,
    scanSelection,
    collapseFile,
    markFileViewed,
    unmarkFileViewed,
    openFileInEditor: onOpenFileInEditor ? openFocusedFileInEditor : undefined,
  });
  useEffect(() => registerNavigationAdapter?.(adapter), [adapter, registerNavigationAdapter]);

  return useMemo(
    () => ({
      tree,
      collapsedFiles,
      expandedFiles,
      activeFilePath: tree.activePath,
      revealFile,
      cancelRevealScroll,
      toggleFile,
      markFileViewed,
      unmarkFileViewed,
    }),
    [
      cancelRevealScroll,
      collapsedFiles,
      expandedFiles,
      markFileViewed,
      revealFile,
      toggleFile,
      tree,
      unmarkFileViewed,
    ],
  );
}
