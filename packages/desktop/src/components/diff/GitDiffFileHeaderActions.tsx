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
import { openGitFileInEditor } from "./gitFileEditorHandoff";
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
  const deleteConflict = isUnavailableDeleteConflict(file);
  const stageState = resolvedStageState(file);
  const conflicted = stageState === FileStageState.conflicted;
  const availability = getGitFileActionAvailability(stageState);
  const pendingPath = indexActions?.pendingPath === file.file;
  const stagePending = pendingPath && indexActions?.pendingAction === "stage";
  const resetPending = pendingPath && indexActions?.pendingAction === "reset";
  const shownPath = displayGitPath(file.file);

  return (
    <>
      {file.conflict_kind ? (
        <ShortcutTooltip
          label={`Conflict: ${conflictKindLabel(file.conflict_kind)}`}
          alignRight
          className="shrink-0"
        >
          <span
            className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--acc-orange)]"
            aria-label={`Conflict: ${conflictKindLabel(file.conflict_kind)}`}
          >
            <TriangleAlertIcon className="size-3.5" aria-hidden />
            Conflict
          </span>
        </ShortcutTooltip>
      ) : null}
      {onOpenFileInEditor ? (
        <HeaderActionButton
          label={
            deleteConflict
              ? `Editor unavailable for deleted conflict ${shownPath}`
              : `Open ${shownPath} in editor`
          }
          title={
            deleteConflict
              ? "Editor unavailable: both sides deleted this file. Stage the deletion to resolve it."
              : "Open in Editor"
          }
          disabled={deleteConflict}
          icon={FilePenLineIcon}
          onClick={() => openGitFileInEditor(file, onOpenFileInEditor)}
        />
      ) : null}
      {indexActions && availability.canStage && !conflicted ? (
        <HeaderActionButton
          label={deleteConflict ? `Stage deletion ${shownPath}` : `Stage ${shownPath}`}
          title={
            stagePending
              ? "Staging file…"
              : deleteConflict
                ? "Stage deletion to mark the conflict resolved"
                : "Stage file — add it to the next commit"
          }
          disabled={indexActions.isPending}
          pending={stagePending}
          icon={PlusIcon}
          onClick={() => indexActions.stage(file.file)}
        />
      ) : null}
      {indexActions && availability.canReset ? (
        <HeaderActionButton
          label={`Unstage ${shownPath}; worktree content is preserved`}
          title={resetPending ? "Unstaging file…" : "Unstage file — keeps worktree changes intact"}
          disabled={indexActions.isPending}
          pending={resetPending}
          icon={MinusIcon}
          onClick={() => indexActions.reset(file.file)}
        />
      ) : null}
    </>
  );
}

export function GitDiffFileActionError({
  file,
  indexActions,
}: {
  file: ChangedFile;
  indexActions?: GitFileIndexActions;
}): React.JSX.Element | null {
  if (resolvedStageState(file) === FileStageState.conflicted) return null;
  const error = indexActions?.error;
  if (!error || error.filePath !== file.file) return null;
  return (
    <div
      role="alert"
      className="border-t border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
    >
      {error.action === "stage" ? "Stage failed" : "Unstage failed"}: {error.message}
    </div>
  );
}
