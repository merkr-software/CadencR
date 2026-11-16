import { startTransition, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  FileTree as PierreFileTree,
  useFileTree as usePierreFileTree,
  type FileTreeProps as PierreFileTreeProps,
} from "@pierre/trees/react";
import type {
  FileTree as FileTreeModel,
  FileTreeDragAndDropConfig,
  FileTreeOptions,
  FileTreeRenamingConfig,
  FileTreeSearchMode,
} from "@pierre/trees";
import { useFileTreeIconSet, type FileTreeIconSet } from "@/hooks/useFileTreeIconSet";
import { useFileTreeShadowStylesheet } from "@/components/file-tree/useFileTreeShadowStylesheet";
import { cn } from "@/lib/utils";
import { resetFileTreePathsPreservingState } from "./cadencrFileTreeModel";
import { CADENCR_FILE_TREE_BASE_CSS } from "./fileTreeBaseCss";
export {
  buildPierreInputs,
  fromPierrePath,
  gitStatusFromUncommittedFiles,
  resetFileTreePathsPreservingState,
  toPierrePath,
} from "./cadencrFileTreeModel";

export interface CadencrFileTreeHookOptions {
  /**
   * Flat list of paths to render. Must be stable (memoize at the caller) —
   * the model is created once and `resetPaths` is called when this changes.
   */
  paths: readonly string[];
  gitStatus?: FileTreeOptions["gitStatus"];
  renaming?: FileTreeRenamingConfig | false;
  dragAndDrop?: FileTreeDragAndDropConfig | false;
  search?: boolean;
  fileTreeSearchMode?: FileTreeSearchMode;
  searchBlurBehavior?: FileTreeOptions["searchBlurBehavior"];
  initialSelectedPaths?: readonly string[];
  initialExpansion?: FileTreeOptions["initialExpansion"];
  composition?: FileTreeOptions["composition"];
  density?: FileTreeOptions["density"];
  stickyFolders?: boolean;
  /** Render every file as a flat basename row while retaining its real path identity. */
  filesOnly?: boolean;
  /** Optional sort override; use a stable function (e.g. ref-backed) if it reads live state. */
  sort?: FileTreeOptions["sort"];
  /** Force a path reset when stable sort inputs change without changing the paths themselves. */
  pathResetVersion?: unknown;
  onSelectionChange?: FileTreeOptions["onSelectionChange"];
  renderRowDecoration?: FileTreeOptions["renderRowDecoration"];
  /** Forces Pierre to repaint rows when decoration-only state changes. */
  rowDecorationVersion?: unknown;
  iconSet?: FileTreeIconSet;
  /**
   * Pierre-form paths (trailing slash for dirs, no slash for files) that
   * should be rendered dimmed, along with all of their descendants. Used
   * for `.gitignore`d sub-trees. Pass only the topmost ignored path in
   * each sub-tree — descendants are matched via a prefix selector, so
   * passing every entry would just bloat the stylesheet.
   *
   * Implemented by injecting a `<style>` element into pierre's shadow
   * root rather than via pierre's `gitStatus`/`ignored` channel, because
   * that channel unconditionally adds every entry's ancestors to the
   * "contains changes" set (see `gitStatusFromUncommittedFiles` notes).
   */
  ignoredPathPrefixes?: readonly string[];
}

export interface CadencrFileTreeHookResult {
  model: FileTreeModel;
}

function haveEqualPaths(previous: readonly string[], next: readonly string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((path, index) => path === next[index]);
}

function useFileTreePathUpdates({
  model,
  paths,
  initialExpansion,
  pathResetVersion,
}: {
  model: FileTreeModel;
  paths: readonly string[];
  initialExpansion: FileTreeOptions["initialExpansion"];
  pathResetVersion: unknown;
}): void {
  const hasPopulatedPathsRef = useRef(paths.length > 0);
  const expandFirstPopulationRef = useRef(initialExpansion === "open");
  const appliedPathsRef = useRef(paths);
  const appliedPathResetVersionRef = useRef(pathResetVersion);

  useEffect(() => {
    const pathsChanged = !haveEqualPaths(appliedPathsRef.current, paths);
    const resetVersionChanged = !Object.is(appliedPathResetVersionRef.current, pathResetVersion);
    appliedPathsRef.current = paths;
    appliedPathResetVersionRef.current = pathResetVersion;
    if (!pathsChanged && !resetVersionChanged) return;

    const isFirstPopulation = !hasPopulatedPathsRef.current && paths.length > 0;
    if (isFirstPopulation) hasPopulatedPathsRef.current = true;
    startTransition(() => {
      resetFileTreePathsPreservingState(model, paths, {
        expandAllDirectories: isFirstPopulation && expandFirstPopulationRef.current,
      });
    });
  }, [model, pathResetVersion, paths]);
}

/**
 * Reusable wrapper around `@pierre/trees`'s `useFileTree`. Plumbs in:
 *
 *  - The workspace-level icon-set preference (overridable per-instance).
 *  - Live updates of `paths` via `model.resetPaths()`.
 *  - Live updates of `gitStatus` via `model.setGitStatus()`.
 *
 * Both the editor file tree and (in a follow-up) the git tab compose this
 * hook with their own data source.
 */
export function useCadencrFileTree({
  paths,
  gitStatus,
  renaming,
  dragAndDrop,
  search = true,
  fileTreeSearchMode = "expand-matches",
  searchBlurBehavior,
  initialSelectedPaths,
  initialExpansion,
  composition,
  density = "compact",
  stickyFolders,
  filesOnly = false,
  sort,
  pathResetVersion,
  onSelectionChange,
  renderRowDecoration,
  rowDecorationVersion,
  iconSet,
  ignoredPathPrefixes,
}: CadencrFileTreeHookOptions): CadencrFileTreeHookResult {
  const { iconSet: globalIconSet } = useFileTreeIconSet();
  const effectiveIconSet = iconSet ?? globalIconSet;
  const onSelectionChangeRef = useRef(onSelectionChange);
  const renderRowDecorationRef = useRef(renderRowDecoration);
  onSelectionChangeRef.current = onSelectionChange;
  renderRowDecorationRef.current = renderRowDecoration;

  // Snapshot the initial inputs — pierre's model is built once and then
  // mutated via methods. Subsequent paths/gitStatus updates are applied via
  // effects below. Pierre re-sorts internally on `resetPaths`, so we hand
  // it raw paths and rely on its canonical ordering.
  const initialOptions = useMemo<FileTreeOptions>(
    () => ({
      paths,
      gitStatus,
      renaming: renaming === false ? undefined : renaming,
      dragAndDrop: dragAndDrop === false ? undefined : dragAndDrop,
      search,
      fileTreeSearchMode,
      searchBlurBehavior,
      initialSelectedPaths,
      initialExpansion,
      composition,
      density,
      stickyFolders,
      filesOnly,
      sort,
      onSelectionChange: (selectedPaths) => onSelectionChangeRef.current?.(selectedPaths),
      renderRowDecoration: (context) => renderRowDecorationRef.current?.(context) ?? null,
      icons: effectiveIconSet,
      unsafeCSS: CADENCR_FILE_TREE_BASE_CSS,
    }),
    // We intentionally only seed once. Updates flow through model methods
    // (see effects below) so we don't tear down and re-create the model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { model } = usePierreFileTree(initialOptions);

  // Update paths in-place on refetch. `resetPaths` on tens of thousands of
  // paths is heavy, so the helper skips equivalent lists and preserves
  // expansion when a real reset is required.
  useFileTreePathUpdates({ model, paths, initialExpansion, pathResetVersion });

  // Diff/apply walks the model once; transition for the same reason.
  useEffect(() => {
    startTransition(() => {
      model.setGitStatus(gitStatus);
    });
  }, [model, gitStatus, rowDecorationVersion]);

  // React to the user toggling the icon-set preference live.
  useEffect(() => {
    model.setIcons(effectiveIconSet);
  }, [model, effectiveIconSet]);

  useEffect(() => {
    model.setFilesOnly(filesOnly);
  }, [filesOnly, model]);

  useGitignoredDimming(model, ignoredPathPrefixes);

  return { model };
}

/**
 * Dim every row whose `data-item-path` starts with one of the given
 * (pierre-form) prefixes — used for `.gitignore`d sub-trees. We do this
 * via shadow-root CSS rather than pierre's `gitStatus`/`ignored` channel
 * because pierre's git pipeline unconditionally adds every ignored
 * entry's ancestors to `directoriesWithChanges`, which would dot the
 * project root for every `node_modules/` we mark.
 *
 * Pierre stamps `data-item-path` on every visible row inside its open
 * shadow root, so a single prefix selector per ignored sub-tree dims
 * the directory and everything below it as virtualization scrolls
 * rows in and out.
 */
function useGitignoredDimming(model: FileTreeModel, prefixes: readonly string[] | undefined): void {
  const css = useMemo(() => buildGitignoredCSS(prefixes), [prefixes]);
  useFileTreeShadowStylesheet(model, "data-cadencr-gitignored", css);
}

function buildGitignoredCSS(prefixes: readonly string[] | undefined): string {
  if (prefixes == null || prefixes.length === 0) return "";
  // Files keep their exact `data-item-path`; directories carry a trailing
  // slash and match descendants via the `^=` prefix selector (which also
  // matches the dir row itself because `^=` is a starts-with test).
  const rowSelectors: string[] = [];
  const iconSelectors: string[] = [];
  for (const prefix of prefixes) {
    const escaped = CSS.escape(prefix);
    const rowSel = prefix.endsWith("/")
      ? `[data-item-path^="${escaped}"]`
      : `[data-item-path="${escaped}"]`;
    rowSelectors.push(rowSel);
    iconSelectors.push(`${rowSel} > [data-item-section="icon"]`);
  }
  // Mirror pierre's built-in `[data-item-git-status='ignored']` look:
  // the row text gets the muted token (`--trees-status-ignored`), the
  // icon gets `opacity: 0.5` because pierre paints it with its own
  // `--trees-fg-muted` color rule that wouldn't pick up a `color:` here.
  return [
    `${rowSelectors.join(",\n")} {\n  color: var(--trees-status-ignored);\n}`,
    `${iconSelectors.join(",\n")} {\n  opacity: 0.5;\n}`,
  ].join("\n");
}

export interface CadencrFileTreeProps extends Omit<PierreFileTreeProps, "model"> {
  /**
   * The pierre model returned from `useCadencrFileTree`. Owning the model in
   * the consumer lets it call rename/move/add/remove methods on it directly.
   */
  model: FileTreeModel;
  /**
   * When true (typically while the backend is fetching the tree), render a
   * centered spinner instead of the (empty) tree. Per `explicit-state.md`.
   */
  isLoading?: boolean;
  /** Error message; rendered instead of the tree when set. */
  errorMessage?: string | null;
  /** Optional placeholder when the tree is empty (no paths). */
  emptyState?: ReactNode;
  className?: string;
}

/**
 * Reusable file-tree shell built around `@pierre/trees`. Renders a loader,
 * error, or empty placeholder when appropriate; otherwise hands off to
 * pierre's `<FileTree>` component.
 */
export function CadencrFileTree({
  model,
  isLoading,
  errorMessage,
  emptyState,
  className,
  ...pierreProps
}: CadencrFileTreeProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div
        className={cn("flex h-full items-center justify-center", className)}
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">Loading file tree…</span>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center px-4 text-center text-xs text-destructive",
          className,
        )}
        role="alert"
      >
        {errorMessage}
      </div>
    );
  }

  if (emptyState) {
    return (
      <div className={cn("relative h-full w-full", className)}>
        <PierreFileTree model={model} className="h-full w-full" {...pierreProps} />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {emptyState}
        </div>
      </div>
    );
  }

  return (
    <PierreFileTree model={model} className={cn("h-full w-full", className)} {...pierreProps} />
  );
}
