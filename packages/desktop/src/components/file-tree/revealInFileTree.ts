import type { FileTree as FileTreeModel, FileTreeDirectoryHandle } from "@pierre/trees";

/**
 * Reveal an FS-form file path inside a pierre file-tree model: expand each
 * ancestor folder in place, then scroll the file row into view and focus
 * it.
 *
 * Returns `false` if the file isn't (yet) part of the model's path set —
 * e.g. the tree is still loading or the file was just created and the
 * refetch hasn't landed. Callers should retry when `paths` next updates.
 *
 * Why not `resetPaths` with `initialExpandedPaths`? That rebuilds the
 * whole tree and clobbers virtualization/scroll state. `getItem` +
 * per-handle `expand()` mutates pierre's tree in place.
 *
 * Why the rAF on `scrollToPath`? `scrollToPath` enqueues a scroll request
 * whose `visibleIndex` is captured at call time. If we call it
 * synchronously after `expand()`, pierre's virtual-row list hasn't yet
 * picked up the newly-revealed descendants, so the request targets a
 * stale index and pierre silently drops it (see
 * `dist/render/FileTreeView.js` ~L1495: `getVisibleRows(idx, idx)[0] ??
 * null` → skip + clearScrollRequest). Deferring to the next animation
 * frame lets the expansion render commit first.
 *
 * `offset: "nearest"` keeps the scrollbar still when the row is already
 * in view, so flipping between visible tabs doesn't jitter.
 */
export function revealInFileTree(
  model: FileTreeModel,
  fsPath: string,
  ensureDirLoaded?: (dirPath: string) => void,
): boolean {
  // Pierre encodes files without a trailing slash, so the FS path doubles
  // as the pierre path for files.
  if (model.getItem(fsPath) == null) {
    // Lazy mode: the file's ancestor directories may not be loaded yet. Pull
    // the ancestor chain in (deduped/cached by the caller's `ensureDirLoaded`)
    // and return false so the caller retries once `paths` next updates.
    if (ensureDirLoaded) requestAncestorChain(fsPath, ensureDirLoaded);
    return false;
  }

  // Walk forward so each parent exists before we look up its child:
  // "src/components/Foo.tsx" → query "src/", then "src/components/".
  let cursor = "";
  const segments = fsPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = cursor ? `${cursor}/${segments[i]}` : segments[i];
    const dir = model.getItem(`${cursor}/`);
    if (dir == null || !dir.isDirectory()) continue;
    // `isDirectory(): true` is a literal-typed method, not a TS predicate,
    // so narrow explicitly to reach `expand`/`isExpanded`.
    const handle = dir as FileTreeDirectoryHandle;
    if (!handle.isExpanded()) handle.expand();
  }

  requestAnimationFrame(() => {
    // The row may have disappeared between the rAF schedule and fire
    // (tree refetch dropped it, user closed the workspace, etc.).
    if (model.getItem(fsPath) == null) return;
    model.scrollToPath(fsPath, { focus: true, offset: "nearest" });
  });
  return true;
}

/**
 * Request every ancestor directory of `fsPath` be loaded, from the shallowest
 * down, so a deep file can be revealed in lazy mode. `ensureDirLoaded` is
 * expected to dedupe already-requested directories, so this is safe to call
 * repeatedly (e.g. each time the reveal effect re-runs while ancestors stream
 * in).
 */
function requestAncestorChain(fsPath: string, ensureDirLoaded: (dirPath: string) => void): void {
  const segments = fsPath.split("/");
  let cursor = "";
  for (let i = 0; i < segments.length - 1; i++) {
    cursor = cursor ? `${cursor}/${segments[i]}` : segments[i];
    ensureDirLoaded(cursor);
  }
}
