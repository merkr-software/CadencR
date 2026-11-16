import { toast } from "sonner";
import type { ChangedFile } from "@/api/generated";
import { displayGitPath } from "@/lib/git-display-path";
import { isUnavailableDeleteConflict } from "./useGitDiffFileTreeModel";

/** Open a Git row in Editor unless the worktree has no file to hand off. */
export function openGitFileInEditor(file: ChangedFile, onOpen: () => void): void {
  if (!isUnavailableDeleteConflict(file)) {
    onOpen();
    return;
  }
  toast.info(`Cannot open ${displayGitPath(file.file)} in Editor`, {
    description: "Both sides deleted this file. Stage the deletion to resolve the conflict.",
  });
}
