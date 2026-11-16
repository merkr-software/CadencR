import { memo, type ReactElement } from "react";
import { FilePenLineIcon, TriangleAlertIcon } from "lucide-react";
import {
  ConflictKind,
  FileStageState,
  type ChangedFile,
  type ConflictKind as ConflictKindValue,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { displayGitPath } from "@/lib/git-display-path";
import { conflictKindLabel, resolvedStageState } from "./useGitDiffFileTreeModel";
import { openGitFileInEditor } from "./gitFileEditorHandoff";
import type { GitFileIndexActions } from "./useGitFileIndexActions";

interface GitConflictFileBannerProps {
  file: ChangedFile;
  indexActions?: GitFileIndexActions;
  onOpenFileInEditor?: () => void;
}

export const GitConflictFileBanner = memo(function GitConflictFileBanner({
  file,
  indexActions,
  onOpenFileInEditor,
}: GitConflictFileBannerProps): ReactElement | null {
  if (resolvedStageState(file) !== FileStageState.conflicted) return null;

  const stagePending =
    indexActions?.pendingPath === file.file && indexActions.pendingAction === "stage";
  const error = indexActions?.error?.filePath === file.file ? indexActions.error.message : null;
  const stageDeletion = file.conflict_kind === ConflictKind.dd;
  const canFix = Boolean(onOpenFileInEditor) && !stageDeletion;

  return (
    <section
      aria-label={`Conflict in ${displayGitPath(file.file)}`}
      className="border-t border-border border-l-2 border-l-[var(--acc-orange)] bg-[color-mix(in_srgb,var(--acc-orange)_6%,var(--background))] px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <TriangleAlertIcon
          className="size-3.5 shrink-0 self-start mt-0.5 text-[var(--acc-orange)]"
          aria-hidden
        />
        <div className="min-w-48 flex-1 text-xs">
          <p className="font-medium text-foreground capitalize">
            {conflictKindLabel(file.conflict_kind)}
          </p>
          <p className="mt-0.5 text-muted-foreground">{conflictMessage(file.conflict_kind)}</p>
        </div>
        {stageDeletion && indexActions ? (
          <Button
            type="button"
            size="sm"
            disabled={indexActions.isPending}
            aria-busy={stagePending}
            onClick={() => indexActions.stage(file.file, { conflicted: true })}
          >
            {stagePending ? "Staging…" : "Stage deletion"}
          </Button>
        ) : null}
        {canFix ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => openGitFileInEditor(file, () => onOpenFileInEditor?.())}
          >
            <FilePenLineIcon />
            Fix
          </Button>
        ) : null}
      </div>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          Stage failed: {error}
        </p>
      )}
    </section>
  );
});

function conflictMessage(kind: ConflictKindValue | null | undefined): string {
  switch (kind) {
    case ConflictKind.dd:
      return "Both sides deleted this path. Stage the deletion to mark it resolved.";
    case ConflictKind.au:
      return "Added on the current side. Open it to confirm the result, then stage it.";
    case ConflictKind.ud:
      return "Deleted on the incoming side while modified here. Open it to keep or remove the result, then stage it.";
    case ConflictKind.ua:
      return "Added on the incoming side. Open it to confirm the result, then stage it.";
    case ConflictKind.du:
      return "Deleted here while modified on the incoming side. Open it to keep or remove the result, then stage it.";
    case ConflictKind.aa:
      return "Both sides added this file. Open it to resolve the result, then stage it.";
    case ConflictKind.uu:
      return "Both sides modified this file. Open it to resolve the markers, then stage it.";
    default:
      return "Open this file to resolve the conflict, then stage it.";
  }
}
