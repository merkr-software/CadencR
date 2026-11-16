import type { ChangedFile } from "@/api/generated";
import { displayGitPath, parseGitDisplayPath } from "@/lib/git-display-path";
import type { GitDiffTreeNavigationAdapter } from "./useGitDiffFileTreeModel";

/**
 * A changed file's path as the tree names it. Pierre labels a row with its
 * path segment, and HTML folds a newline in it into a space, so each segment
 * is written the way git prints it (`dir/"a\nb.txt"`). An ordinary path is
 * returned as it is. Display only: actions always take the real path back.
 */
export function gitDiffTreePath(path: string): string {
  const shown = displayGitPath(path);
  // A path that needs no escape is shown as it is: skip the per-segment work.
  if (shown === path) return path;
  return path.split("/").map(displayGitPath).join("/");
}

/** The real path of a tree path, file or folder. */
export function realGitDiffTreePath(treePath: string): string {
  if (!treePath.includes('"')) return treePath;
  return treePath.split("/").map(parseGitDisplayPath).join("/");
}

/** The files keyed by their tree path; `files` itself when no name needs escaping. */
export function gitDiffTreeFiles(files: readonly ChangedFile[]): readonly ChangedFile[] {
  let renamed = false;
  const treeFiles = files.map((file) => {
    const treePath = gitDiffTreePath(file.file);
    if (treePath === file.file) return file;
    renamed = true;
    return { ...file, file: treePath };
  });
  return renamed ? treeFiles : files;
}

/** Tree navigation that takes and reports real paths. */
export function realPathNavigation(
  tree: GitDiffTreeNavigationAdapter,
): GitDiffTreeNavigationAdapter {
  const real = (path: string | null): string | null =>
    path == null ? null : realGitDiffTreePath(path);
  return {
    getActivePath: () => real(tree.getActivePath()),
    selectPath: (filePath) => tree.selectPath(gitDiffTreePath(filePath)),
    moveSelection: (offset) => real(tree.moveSelection(offset)),
    focusActive: tree.focusActive,
  };
}
