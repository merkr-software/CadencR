import { useCallback, useMemo, useRef } from "react";
import type {
  FileTree,
  FileTreeOptions,
  FileTreeRowDecoration,
  FileTreeSortComparator,
} from "@pierre/trees";
import { useFileTreeSelection, useFileTreeSelector } from "@pierre/trees/react";
import {
  ConflictKind,
  FileStageState,
  type ChangedFile,
  type ConflictKind as ConflictKindValue,
  type FileStageState as FileStageStateValue,
} from "@/api/generated";
import { useCadencrFileTree } from "@/components/file-tree/CadencrFileTree";
import { expandFileTreeAncestors } from "@/components/file-tree/revealInFileTree";
import {
  gitDiffTreeFiles,
  gitDiffTreePath,
  realGitDiffTreePath,
  realPathNavigation,
} from "./gitDiffTreePath";
import {
  useGitDiffTreeDisplaySetting,
  type GitDiffTreeDisplayMode,
} from "./useGitDiffTreeDisplaySetting";

type PierreGitStatus = NonNullable<FileTreeOptions["gitStatus"]>[number]["status"];

export interface GitDiffTreeNavigationAdapter {
  getActivePath: () => string | null;
  selectPath: (filePath: string) => boolean;
  moveSelection: (offset: -1 | 1) => string | null;
  focusActive: () => boolean;
}

interface GitDiffFileTreeModelResult {
  model: FileTree;
  activePath: string | null;
  displayMode: GitDiffTreeDisplayMode;
  isDisplayModePending: boolean;
  setDisplayMode: (displayMode: GitDiffTreeDisplayMode) => void;
  resolveFilePath: (treePath: string) => string | null;
  navigation: GitDiffTreeNavigationAdapter;
}

interface UseGitDiffFileTreeModelOptions {
  files: readonly ChangedFile[];
  onSelectionChange: (filePath: string) => void;
  reviewCountsByFile?: ReadonlyMap<string, number>;
}

export function buildGitDiffTreePaths(files: readonly Pick<ChangedFile, "file">[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const segments = file.file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(`${segments.slice(0, index).join("/")}/`);
    }
    paths.add(file.file);
  }
  return [...paths];
}

export function statusFromChangedFile(file: ChangedFile): PierreGitStatus {
  const stageState = resolvedStageState(file);
  if (stageState === FileStageState.conflicted) return "modified";
  if (stageState === FileStageState.untracked) return "untracked";
  if (file.status.startsWith("A")) return "added";
  if (file.status.startsWith("D")) return "deleted";
  if (file.status.startsWith("R") || file.status.startsWith("C")) return "renamed";
  return "modified";
}

export function buildGitDiffTreeStatus(
  files: readonly ChangedFile[],
): NonNullable<FileTreeOptions["gitStatus"]> {
  return files.map((file) => ({ path: file.file, status: statusFromChangedFile(file) }));
}

export function resolvedStageState(file: ChangedFile): FileStageStateValue {
  if (file.stage_state != null) return file.stage_state;
  return file.is_staged ? FileStageState.staged : FileStageState.not_applicable;
}

/** 0 = conflicted (sort first), 1 = everything else. */
export function conflictSortRank(file: ChangedFile): 0 | 1 {
  return resolvedStageState(file) === FileStageState.conflicted ? 0 : 1;
}

/**
 * Memoized by array identity: the diff pane and the file tree both need this
 * order for the same `changedFiles` array, and the git watcher invalidates that
 * query about once a second during a rebase — sorting a few thousand paths
 * twice per refetch is main-thread time nobody asked for.
 *
 * Callers only read the result, so handing them the same array is safe.
 */
const diffOrderCache = new WeakMap<readonly ChangedFile[], ChangedFile[]>();

/** Flat-list ordering: conflicted files first, then path name. */
export function sortChangedFilesForDiff(files: readonly ChangedFile[]): ChangedFile[] {
  const cached = diffOrderCache.get(files);
  if (cached) return cached;
  const ordered = [...files].sort((left, right) => {
    const byConflict = conflictSortRank(left) - conflictSortRank(right);
    if (byConflict !== 0) return byConflict;
    return left.file.localeCompare(right.file);
  });
  diffOrderCache.set(files, ordered);
  return ordered;
}

export function conflictKindLabel(kind: ConflictKindValue | null | undefined): string {
  switch (kind) {
    case ConflictKind.dd:
      return "both deleted";
    case ConflictKind.au:
      return "added by us";
    case ConflictKind.ud:
      return "deleted by them";
    case ConflictKind.ua:
      return "added by them";
    case ConflictKind.du:
      return "deleted by us";
    case ConflictKind.aa:
      return "both added";
    case ConflictKind.uu:
      return "both modified";
    default:
      return "unmerged";
  }
}

export function isUnavailableDeleteConflict(file: ChangedFile): boolean {
  return (
    resolvedStageState(file) === FileStageState.conflicted && file.conflict_kind === ConflictKind.dd
  );
}

export function gitDiffTreeConflictDecoration(file: ChangedFile): FileTreeRowDecoration | null {
  if (resolvedStageState(file) !== FileStageState.conflicted) return null;
  const label = `Conflict: ${conflictKindLabel(file.conflict_kind)}`;
  return { text: "Conflict", title: label };
}

function reviewDecoration(
  count: number,
  conflict: FileTreeRowDecoration | null,
): FileTreeRowDecoration | null {
  if (count === 0) return conflict;
  const reviewLabel = `${count} open review ${count === 1 ? "thread" : "threads"}`;
  if (conflict) {
    return {
      text: `Conflict · ${count}`,
      title: `${conflict.title}; ${reviewLabel}`,
    };
  }
  return { text: `${count} open`, title: reviewLabel };
}

function selectGitDiffTreePath(model: FileTree, filePath: string): boolean {
  const item = model.getItem(filePath);
  if (item == null || item.isDirectory()) return false;
  for (const selectedPath of model.getSelectedPaths()) {
    if (selectedPath !== filePath) model.getItem(selectedPath)?.deselect();
  }
  item.select();
  const settle = (): void => {
    // `scrollToPath` does the focusing; the row may also have gone away while a
    // rAF was pending, in which case there is nothing left to aim at.
    if (model.getItem(filePath) == null) return;
    model.scrollToPath(filePath, { focus: true, offset: "nearest" });
  };
  // A file inside a collapsed folder has no row to focus, and pierre resolves
  // the scroll to the nearest *visible* ancestor instead — which then reads
  // back as the focused path and derails the next move. Open the way first.
  if (expandFileTreeAncestors(model, filePath)) requestAnimationFrame(settle);
  else settle();
  return true;
}

/**
 * The paths `j`/`k` step through, in the order the diff pane renders them.
 *
 * Order comes from the diff, never the tree: the two disagree by construction,
 * since the tree groups folders and sorts rows by basename while the diff list
 * is a flat full-path sort. Walking tree rows therefore scrolls the diff pane
 * backwards and forwards at random. `j`/`k` exist to move down the diff, so the
 * diff's order wins and the tree selection follows along.
 *
 * A collapsed folder does not remove its files from the walk — they are still
 * in the diff, and the row is expanded into view on arrival. A search does
 * scope it: the query is an explicit "only these", and stepping onto a row the
 * user just filtered away would be answering a question they didn't ask.
 */
function navigableOrder(model: FileTree, orderedPaths: readonly string[]): readonly string[] {
  if (model.getSearchValue().trim().length === 0) return orderedPaths;
  const visible = new Set(model.getVisiblePaths());
  return orderedPaths.filter((path) => visible.has(path));
}

/**
 * Keyboard navigation over the diff's file list, projected onto the tree.
 */
function useNavigationAdapter(
  model: FileTree,
  filePaths: ReadonlySet<string>,
  orderedPaths: readonly string[],
) {
  const pathsRef = useRef({ filePaths, orderedPaths });
  pathsRef.current = { filePaths, orderedPaths };
  // Last resort for when the tree reports neither a selection nor a focus —
  // clicking away drops both, and `j` should still resume where it left off.
  const activePathRef = useRef<string | null>(null);
  return useMemo<GitDiffTreeNavigationAdapter>(() => {
    const resolveActivePath = (): string | null => {
      const { filePaths: files } = pathsRef.current;
      const live = pickActivePath(model.getSelectedPaths(), model.getFocusedPath(), files);
      if (live != null) return live;
      const remembered = activePathRef.current;
      return remembered != null && files.has(remembered) ? remembered : null;
    };
    const select = (filePath: string): boolean => {
      if (!selectGitDiffTreePath(model, filePath)) return false;
      activePathRef.current = filePath;
      return true;
    };
    return {
      getActivePath: resolveActivePath,
      selectPath: (filePath) => pathsRef.current.filePaths.has(filePath) && select(filePath),
      moveSelection: (offset) => {
        const order = navigableOrder(model, pathsRef.current.orderedPaths);
        if (order.length === 0) return null;
        const active = resolveActivePath();
        const currentIndex = active == null ? -1 : order.indexOf(active);
        // No selection yet: `j` starts at the top of the diff, `k` at the end.
        const nextIndex =
          currentIndex < 0 ? (offset === 1 ? 0 : order.length - 1) : currentIndex + offset;
        // Clamping rather than wrapping keeps the ends of the list quiet, and
        // still reports the move as handled so the key never falls through to
        // the tree's type-ahead search.
        const nextPath = order[Math.max(0, Math.min(order.length - 1, nextIndex))];
        return nextPath && select(nextPath) ? nextPath : null;
      },
      focusActive: () => {
        const path = resolveActivePath();
        return path != null && select(path);
      },
    };
  }, [model]);
}

/**
 * Which file the diff treats as current, from a selection and focus snapshot.
 *
 * Selection wins over focus. `select()` updates it synchronously, whereas focus
 * can be a frame behind — a file inside a collapsed folder is focused from a
 * `requestAnimationFrame` — can sit on a folder row, and is dropped entirely
 * when the tree loses DOM focus. Reading focus first meant a second `j` fired
 * inside that frame re-landed on the row the user had just left.
 */
function pickActivePath(
  selectedPaths: readonly string[],
  focusedPath: string | null | undefined,
  filePaths: ReadonlySet<string>,
): string | null {
  const selected = selectedPaths.findLast((path) => filePaths.has(path));
  if (selected != null) return selected;
  return focusedPath != null && filePaths.has(focusedPath) ? focusedPath : null;
}

function useActivePath(model: FileTree, filePaths: ReadonlySet<string>): string | null {
  const selectedPaths = useFileTreeSelection(model);
  const focusedPath = useFileTreeSelector(model, (current) => current.getFocusedPath());
  return pickActivePath(selectedPaths, focusedPath, filePaths);
}

function useConflictSort(files: readonly ChangedFile[]) {
  const conflictPaths = useMemo(
    () =>
      new Set(
        files
          .filter((file) => resolvedStageState(file) === FileStageState.conflicted)
          .map((file) => file.file),
      ),
    [files],
  );
  const conflictPathsRef = useRef(conflictPaths);
  conflictPathsRef.current = conflictPaths;
  const version = useMemo(() => [...conflictPaths].sort().join("\0"), [conflictPaths]);
  const comparator = useMemo<FileTreeSortComparator>(
    () => (left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      const leftConflict = conflictPathsRef.current.has(left.path) ? 0 : 1;
      const rightConflict = conflictPathsRef.current.has(right.path) ? 0 : 1;
      if (leftConflict !== rightConflict) return leftConflict - rightConflict;
      return left.basename.localeCompare(right.basename, undefined, { sensitivity: "base" });
    },
    [],
  );
  return { comparator, version };
}

export function useGitDiffFileTreeModel({
  files: changedFiles,
  onSelectionChange,
  reviewCountsByFile,
}: UseGitDiffFileTreeModelOptions): GitDiffFileTreeModelResult {
  const {
    displayMode,
    setDisplayMode,
    isPending: isDisplayModePending,
  } = useGitDiffTreeDisplaySetting();
  // The tree names a file by its escaped path; everything handed out is real.
  const files = useMemo(() => gitDiffTreeFiles(changedFiles), [changedFiles]);
  const paths = useMemo(() => buildGitDiffTreePaths(files), [files]);
  const gitStatus = useMemo(() => buildGitDiffTreeStatus(files), [files]);
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.file, file])), [files]);
  const filePaths = useMemo(() => new Set(fileByPath.keys()), [fileByPath]);
  // Mirrors `DiffContent`'s render order so keyboard navigation moves down the
  // diff pane rather than down the tree.
  const orderedPaths = useMemo(
    () => sortChangedFilesForDiff(changedFiles).map((file) => gitDiffTreePath(file.file)),
    [changedFiles],
  );
  const conflictSort = useConflictSort(files);
  const handleSelectionChange = useCallback(
    (selectedPaths: readonly string[]): void => {
      const selectedPath = selectedPaths.findLast((path) => filePaths.has(path));
      if (selectedPath) onSelectionChange(realGitDiffTreePath(selectedPath));
    },
    [filePaths, onSelectionChange],
  );
  const renderRowDecoration = useCallback(
    ({ item }: { item: { kind: "directory" | "file"; path: string } }) => {
      if (item.kind === "directory") return null;
      const file = fileByPath.get(item.path);
      const conflict = file ? gitDiffTreeConflictDecoration(file) : null;
      const reviewCount =
        displayMode === "filenames"
          ? (reviewCountsByFile?.get(realGitDiffTreePath(item.path)) ?? 0)
          : 0;
      return reviewDecoration(reviewCount, conflict);
    },
    [displayMode, fileByPath, reviewCountsByFile],
  );
  const { model } = useCadencrFileTree({
    paths,
    gitStatus,
    filesOnly: displayMode === "filenames",
    initialExpansion: "open",
    search: true,
    searchBlurBehavior: "retain",
    fileTreeSearchMode: "hide-non-matches",
    stickyFolders: true,
    renaming: false,
    dragAndDrop: false,
    sort: conflictSort.comparator,
    pathResetVersion: conflictSort.version,
    composition: {
      contextMenu: { enabled: true, triggerMode: "both", buttonVisibility: "when-needed" },
    },
    onSelectionChange: handleSelectionChange,
    renderRowDecoration,
    rowDecorationVersion: renderRowDecoration,
  });
  const activeTreePath = useActivePath(model, filePaths);
  const activePath = activeTreePath == null ? null : realGitDiffTreePath(activeTreePath);
  const treeNavigation = useNavigationAdapter(model, filePaths, orderedPaths);
  const navigation = useMemo(() => realPathNavigation(treeNavigation), [treeNavigation]);
  const resolveFilePath = useCallback(
    (path: string) => (filePaths.has(path) ? realGitDiffTreePath(path) : null),
    [filePaths],
  );

  return useMemo(
    () => ({
      model,
      activePath,
      displayMode,
      isDisplayModePending,
      setDisplayMode,
      resolveFilePath,
      navigation,
    }),
    [
      activePath,
      displayMode,
      isDisplayModePending,
      model,
      navigation,
      resolveFilePath,
      setDisplayMode,
    ],
  );
}
