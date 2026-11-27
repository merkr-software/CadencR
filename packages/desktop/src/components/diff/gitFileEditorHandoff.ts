import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
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
  toast.info(
    translateUi(
      "workspace.git.gitFileEditorHandoff.cannotOpenPathInEditor",
      "Cannot open {{path}} in Editor",
      { path: displayGitPath(file.file) },
    ),
    {
      description: translateUi(
        "workspace.git.gitFileEditorHandoff.bothSidesDeletedThisFileStageThe",
        "Both sides deleted this file. Stage the deletion to resolve the conflict.",
      ),
    },
  );
}

export function deletedConflictTooltip(t: UiTranslator): string {
  return t(
    "workspace.git.gitDiffFileHeaderActions.editorUnavailableBothSidesDeletedThisFile",
    "Editor unavailable: both sides deleted this file. Stage the deletion to resolve it.",
  );
}
