import {
  ClipboardCopyIcon,
  FilePenLineIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  type LucideIcon,
} from "lucide-react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { copyToClipboard } from "@/lib/clipboard";
import type { UiTranslator } from "@/lib/i18n/ui";
import { deletedConflictTooltip, openGitFileInEditor } from "./gitFileEditorHandoff";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import { isUnavailableDeleteConflict, resolvedStageState } from "./useGitDiffFileTreeModel";

/** One entry of a changed file's actions menu. */
export type GitFileActionEntry =
  | {
      kind: "action";
      id: "open-in-editor" | "copy-path" | "stage" | "reset";
      icon: LucideIcon;
      label: string;
      disabled: boolean;
      /** This file's stage request is running: `icon` is a spinner. */
      pending: boolean;
      run: () => void;
    }
  | { kind: "note"; id: "editor-unavailable"; text: string };

interface GitFileActionsOptions {
  /** The changed file, or `undefined` for a folder (only Copy path applies). */
  file: ChangedFile | undefined;
  /** The exact Git path Copy path copies. */
  path: string;
  indexActions: GitFileIndexActions | undefined;
  /** Stage and Unstage are disabled while true (a stage request or its confirmation). */
  busy: boolean;
  onOpenFileInEditor: ((filePath: string) => void) | undefined;
  t: UiTranslator;
}

/**
 * A changed file's actions, in menu order: Open in Editor (with why it is
 * unavailable for a file both sides deleted), Copy path, then Stage or
 * Unstage, labelled "Staging…" / "Unstaging…" while that file's request runs.
 * The desktop file tree's context menu and the phone file sheet both render
 * this list, each with its own menu items.
 */
export function gitFileActions({
  file,
  path,
  indexActions,
  busy,
  onOpenFileInEditor,
  t,
}: GitFileActionsOptions): GitFileActionEntry[] {
  const entries: GitFileActionEntry[] = [];
  const unavailable = file ? isUnavailableDeleteConflict(file) : false;
  if (file && onOpenFileInEditor) {
    entries.push({
      kind: "action",
      id: "open-in-editor",
      icon: FilePenLineIcon,
      label: t("workspace.git.gitDiffFileTree.openInEditor", "Open in Editor"),
      disabled: unavailable,
      pending: false,
      run: () => openGitFileInEditor(file, () => onOpenFileInEditor(file.file)),
    });
  }
  if (unavailable)
    entries.push({ kind: "note", id: "editor-unavailable", text: deletedConflictTooltip(t) });
  entries.push({
    kind: "action",
    id: "copy-path",
    icon: ClipboardCopyIcon,
    label: t("workspace.git.gitDiffFileTree.copyPath", "Copy path"),
    disabled: false,
    pending: false,
    run: () =>
      void copyToClipboard(path, t("workspace.git.gitDiffFileTree.pathCopied", "Path copied")),
  });
  if (!file || !indexActions) return entries;
  const stageState = resolvedStageState(file);
  const availability = getGitFileActionAvailability(stageState);
  const pendingAction = indexActions.pendingPath === path ? indexActions.pendingAction : null;
  if (availability.canStage) {
    const staging = pendingAction === "stage";
    entries.push({
      kind: "action",
      id: "stage",
      icon: staging ? Loader2Icon : PlusIcon,
      label: staging
        ? t("workspace.git.gitDiffFileTree.staging", "Staging…")
        : unavailable
          ? t("workspace.git.gitDiffFileTree.stageDeletion", "Stage deletion")
          : t("workspace.git.gitDiffFileTree.stageFile", "Stage file"),
      disabled: busy,
      pending: staging,
      run: () =>
        indexActions.stage(file.file, { conflicted: stageState === FileStageState.conflicted }),
    });
  }
  if (availability.canReset) {
    const unstaging = pendingAction === "reset";
    entries.push({
      kind: "action",
      id: "reset",
      icon: unstaging ? Loader2Icon : MinusIcon,
      label: unstaging
        ? t("workspace.git.gitDiffFileTree.unstaging", "Unstaging…")
        : t(
            "workspace.git.gitDiffFileTree.unstageFileKeepsWorktreeChanges",
            "Unstage file (keeps worktree changes)",
          ),
      disabled: busy,
      pending: unstaging,
      run: () => indexActions.reset(file.file),
    });
  }
  return entries;
}
