import { useUiTranslation } from "@/lib/i18n/ui";
import {
  FilePenLineIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { getGitFileActionAvailability, type GitFileIndexActions } from "./useGitFileIndexActions";
import {
  conflictKindLabel,
  isUnavailableDeleteConflict,
  resolvedStageState,
} from "./useGitDiffFileTreeModel";
import { deletedConflictTooltip, openGitFileInEditor } from "./gitFileEditorHandoff";
import { displayGitPath } from "@/lib/git-display-path";

interface GitDiffFileHeaderActionsProps {
  file: ChangedFile;
  indexActions?: GitFileIndexActions;
  onOpenFileInEditor?: () => void;
}

function HeaderActionButton({
  label,
  title,
  disabled,
  pending,
  onClick,
  icon: Icon,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  pending?: boolean;
  onClick: () => void;
  icon: LucideIcon;
}): React.JSX.Element {
  return (
    <ShortcutTooltip label={title} alignRight className="shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
        className="size-5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Icon className="size-3.5" aria-hidden />
        )}
      </Button>
    </ShortcutTooltip>
  );
}

export function GitDiffFileHeaderActions({
  file,
  indexActions,
  onOpenFileInEditor,
}: GitDiffFileHeaderActionsProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const deleteConflict = isUnavailableDeleteConflict(file);
  const stageState = resolvedStageState(file);
  const availability = getGitFileActionAvailability(stageState);
  const stagePending =
    indexActions?.pendingPath === file.file && indexActions?.pendingAction === "stage";
  const resetPending =
    indexActions?.pendingPath === file.file && indexActions?.pendingAction === "reset";
  const shownPath = displayGitPath(file.file);

  return (
    <>
      {file.conflict_kind && <ConflictBadge kind={file.conflict_kind} />}
      {onOpenFileInEditor ? (
        <HeaderActionButton
          label={
            deleteConflict
              ? t(
                  "workspace.git.gitDiffFileHeaderActions.editorUnavailableForDeletedConflictPath",
                  "Editor unavailable for deleted conflict {{path}}",
                  { path: shownPath },
                )
              : t(
                  "workspace.git.gitDiffFileHeaderActions.openPathInEditor",
                  "Open {{path}} in editor",
                  { path: shownPath },
                )
          }
          title={
            deleteConflict
              ? deletedConflictTooltip(t)
              : t("workspace.git.gitDiffFileHeaderActions.openInEditor", "Open in Editor")
          }
          disabled={deleteConflict}
          icon={FilePenLineIcon}
          onClick={() => openGitFileInEditor(file, onOpenFileInEditor)}
        />
      ) : null}
      {indexActions && availability.canStage && stageState !== FileStageState.conflicted ? (
        <HeaderActionButton
          label={
            deleteConflict
              ? t(
                  "workspace.git.gitDiffFileHeaderActions.stageDeletionPath",
                  "Stage deletion {{path}}",
                  { path: shownPath },
                )
              : t("workspace.git.gitDiffFileHeaderActions.stagePath", "Stage {{path}}", {
                  path: shownPath,
                })
          }
          title={
            stagePending
              ? t("workspace.git.gitDiffFileHeaderActions.stagingFile", "Staging file…")
              : deleteConflict
                ? t(
                    "workspace.git.gitDiffFileHeaderActions.stageDeletionToMarkTheConflictResolved",
                    "Stage deletion to mark the conflict resolved",
                  )
                : t(
                    "workspace.git.gitDiffFileHeaderActions.stageFileAddItToThe",
                    "Stage file — add it to the next commit",
                  )
          }
          disabled={indexActions.isPending}
          pending={stagePending}
          icon={PlusIcon}
          onClick={() => indexActions.stage(file.file)}
        />
      ) : null}
      {indexActions && availability.canReset ? (
        <HeaderActionButton
          label={t(
            "workspace.git.gitDiffFileHeaderActions.unstagePathWorktreeContentIsPreserved",
            "Unstage {{path}}; worktree content is preserved",
            { path: shownPath },
          )}
          title={
            resetPending
              ? t("workspace.git.gitDiffFileHeaderActions.unstagingFile", "Unstaging file…")
              : t(
                  "workspace.git.gitDiffFileHeaderActions.unstageFileKeepsWorktreeChangesIntact",
                  "Unstage file — keeps worktree changes intact",
                )
          }
          disabled={indexActions.isPending}
          pending={resetPending}
          icon={MinusIcon}
          onClick={() => indexActions.reset(file.file)}
        />
      ) : null}
    </>
  );
}

function ConflictBadge({
  kind,
}: {
  kind: NonNullable<ChangedFile["conflict_kind"]>;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const label = t("workspace.git.gitDiffFileHeaderActions.conflictKind", "Conflict: {{kind}}", {
    kind: conflictKindLabel(kind, t),
  });
  return (
    <ShortcutTooltip label={label} alignRight className="shrink-0">
      <span
        className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--acc-orange)]"
        aria-label={label}
      >
        <TriangleAlertIcon className="size-3.5" aria-hidden />
        {t("workspace.git.gitDiffFileHeaderActions.conflict", "Conflict")}
      </span>
    </ShortcutTooltip>
  );
}

export function GitDiffFileActionError({
  file,
  indexActions,
}: {
  file: ChangedFile;
  indexActions?: GitFileIndexActions;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  if (resolvedStageState(file) === FileStageState.conflicted) return null;
  const error = indexActions?.error;
  if (!error || error.filePath !== file.file) return null;
  return (
    <div
      role="alert"
      className="border-t border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
    >
      {error.action === "stage"
        ? t("workspace.git.gitDiffFileHeaderActions.stageFailed", "Stage failed")
        : t("workspace.git.gitDiffFileHeaderActions.unstageFailed", "Unstage failed")}
      : {error.message}
    </div>
  );
}
