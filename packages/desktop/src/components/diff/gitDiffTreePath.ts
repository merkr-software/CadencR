import type { ChangedFile } from "@/api/generated";
import { displayGitTreePath, parseGitTreePath } from "@/lib/git-display-path";
import type { GitDiffTreeNavigationAdapter } from "./useGitDiffFileTreeModel";

/** The files keyed by their tree path; `files` itself when no name needs escaping. */
export function gitDiffTreeFiles(files: readonly ChangedFile[]): readonly ChangedFile[] {
  let renamed = false;
  const treeFiles = files.map((file) => {
    const treePath = displayGitTreePath(file.file);
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
    path == null ? null : parseGitTreePath(path);
  return {
    getActivePath: () => real(tree.getActivePath()),
    selectPath: (filePath) => tree.selectPath(displayGitTreePath(filePath)),
    moveSelection: (offset) => real(tree.moveSelection(offset)),
    focusActive: tree.focusActive,
  };
}
