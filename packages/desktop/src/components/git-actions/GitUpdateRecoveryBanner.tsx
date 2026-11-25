import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, Undo2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { type GitOperationKind } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { gitUpdateActionLabel, gitUpdateContinueDisabledReason } from "./gitUpdateMessages";
import { useGitUpdateRecoveryActions } from "./useGitUpdateRecoveryActions";

interface GitUpdateRecoveryRegionProps {
  featureId: number;
  onRequestUncommitted: () => void;
}

export const GitUpdateRecoveryRegion = memo(function GitUpdateRecoveryRegion({
  featureId,
  onRequestUncommitted,
}: GitUpdateRecoveryRegionProps): ReactElement | null {
  const status = useGitStatusStore(
    useShallow((state) => {
      const snapshot = state.byFeature[featureId];
      return {
        operation: snapshot?.operation ?? null,
        conflictCount: snapshot?.conflict_count ?? 0,
      };
    }),
  );
  useRequestUncommittedOnConflict(status.operation, status.conflictCount, onRequestUncommitted);

  if (!status.operation) return null;
  return (
    <GitUpdateRecoveryBanner
      featureId={featureId}
      operation={status.operation}
      conflictCount={status.conflictCount}
    />
  );
});

function useRequestUncommittedOnConflict(
  operation: GitOperationKind | null,
  conflictCount: number,
  onRequestUncommitted: () => void,
): void {
  const tracking = useRef({ operation: null as GitOperationKind | null, hadConflicts: false });
  useEffect(() => {
    if (!operation) {
      tracking.current = { operation: null, hadConflicts: false };
      return;
    }
    if (tracking.current.operation !== operation) {
      tracking.current = { operation, hadConflicts: false };
    }
    if (conflictCount === 0) {
      tracking.current.hadConflicts = false;
      return;
    }
    if (tracking.current.hadConflicts) return;
    tracking.current.hadConflicts = true;
    onRequestUncommitted();
  }, [conflictCount, onRequestUncommitted, operation]);
}

interface GitUpdateRecoveryBannerProps {
  featureId: number;
  operation: GitOperationKind;
  conflictCount: number;
}

export const GitUpdateRecoveryBanner = memo(function GitUpdateRecoveryBanner({
  featureId,
  operation,
  conflictCount,
}: GitUpdateRecoveryBannerProps): ReactElement {
  const { t } = useUiTranslation();
  const actions = useGitUpdateRecoveryActions({ featureId, operation, conflictCount });
  const continueReason = gitUpdateContinueDisabledReason(conflictCount, t);
  const resolved = continueReason === null;
  const accent = resolved ? "var(--acc-green)" : "var(--acc-orange)";

  return (
    <section
      aria-label={t(
        "workspace.git.gitUpdateRecoveryBanner.gitUpdateRecovery",
        "Git update recovery",
      )}
      style={{ "--recovery-accent": accent } as CSSProperties}
      className="shrink-0 border-b border-[color-mix(in_oklab,var(--recovery-accent)_35%,transparent)] bg-[color-mix(in_oklab,var(--recovery-accent)_8%,var(--card))] px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--recovery-accent)]">
            {resolved ? (
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            ) : (
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
            )}
            {resolved
              ? operation === "rebase"
                ? t("workspace.git.gitUpdateRecoveryBanner.rebaseReady", "Rebase ready to continue")
                : t("workspace.git.gitUpdateRecoveryBanner.mergeReady", "Merge ready to continue")
              : operation === "rebase"
                ? t(
                    "workspace.git.gitUpdateRecoveryBanner.rebasePaused",
                    "Rebase paused on conflicts",
                  )
                : t(
                    "workspace.git.gitUpdateRecoveryBanner.mergePaused",
                    "Merge paused on conflicts",
                  )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {continueReason ??
              (operation === "rebase"
                ? t(
                    "workspace.git.gitUpdateRecoveryBanner.finishRebase",
                    "All conflicts staged. Continue to finish the rebase, or abort to undo it.",
                  )
                : t(
                    "workspace.git.gitUpdateRecoveryBanner.finishMerge",
                    "All conflicts staged. Continue to finish the merge, or abort to undo it.",
                  ))}
          </p>
          {actions.error && (
            <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-destructive">
              {actions.error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void actions.abortUpdate()}
            disabled={actions.pending}
          >
            {actions.pendingAction === "abort" ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Undo2 className="mr-2 size-3.5" />
            )}
            {gitUpdateActionLabel("abort", operation, t)}
          </Button>
          <Button
            size="sm"
            variant={resolved ? "default" : "secondary"}
            onClick={() => void actions.continueUpdate()}
            disabled={actions.pending || continueReason !== null}
            title={continueReason ?? gitUpdateActionLabel("continue", operation, t)}
          >
            {actions.pendingAction === "continue" ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : (
              <Play className="mr-2 size-3.5" />
            )}
            {gitUpdateActionLabel("continue", operation, t)}
          </Button>
        </div>
      </div>
    </section>
  );
});
