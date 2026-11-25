import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FileStageState,
  useResetFile,
  useStageFile,
  type FileStageState as FileStageStateValue,
} from "@/api/generated";
import { useGitPathPrefix } from "@/hooks/useGitPathPrefix";
import { apiErrorMessage } from "@/lib/api-errors";
import { gitPathToFeaturePath } from "@/lib/git-paths";
import { useEditorStore } from "@/stores/editor-store";
import { displayGitPath } from "@/lib/git-display-path";

export type GitFileIndexAction = "stage" | "reset";

export interface GitFileIndexError {
  action: GitFileIndexAction;
  filePath: string;
  message: string;
}

type IndexFailure = Pick<GitFileIndexError, "action" | "filePath"> &
  ({ kind: "backend"; rawMessage: string } | { kind: "root-loading" | "dirty-buffer" });

export interface StageFileOptions {
  /** When true, toast a warning after a successful stage (unresolved conflict path). */
  conflicted?: boolean;
}

export interface GitFileIndexActions {
  stage: (filePath: string, options?: StageFileOptions) => void;
  reset: (filePath: string) => void;
  isPending: boolean;
  pendingAction: GitFileIndexAction | null;
  pendingPath: string | null;
  error: GitFileIndexError | null;
}

export interface GitFileActionAvailability {
  canStage: boolean;
  canReset: boolean;
}

/** `gitPath` is checkout-relative; editor tabs are feature-relative. */
function hasDirtyEditorBuffer(featureId: number, gitPath: string, gitPrefix: string): boolean {
  const feature = useEditorStore.getState().features[featureId];
  const filePath = gitPathToFeaturePath(gitPath, gitPrefix);
  if (!feature || filePath == null) return false;
  return Object.values(feature.panes).some((pane) =>
    pane.tabs.some((tab) => tab.filePath === filePath && tab.isDirty),
  );
}

/** Whole-file mutation availability derived exclusively from typed stage state. */
export function getGitFileActionAvailability(
  stageState: FileStageStateValue,
): GitFileActionAvailability {
  return {
    canStage:
      stageState === FileStageState.untracked ||
      stageState === FileStageState.unstaged ||
      stageState === FileStageState.both ||
      stageState === FileStageState.conflicted,
    canReset: stageState === FileStageState.staged || stageState === FileStageState.both,
  };
}

/** Stage/reset mutations with exact paths, shared pending state, and visible failures. */
export function useGitFileIndexActions(featureId: number): GitFileIndexActions {
  const { t } = useUiTranslation();
  const [failure, setError] = useState<IndexFailure | null>(null);
  const error = useMemo(
    () =>
      failure
        ? {
            action: failure.action,
            filePath: failure.filePath,
            message: indexFailureMessage(failure, t),
          }
        : null,
    [failure, t],
  );
  const [pending, setPending] = useState<{
    action: GitFileIndexAction;
    filePath: string;
  } | null>(null);
  const gitPrefix = useGitPathPrefix(featureId);
  const flightAcquiredRef = useRef(false);
  const conflictWarnPathRef = useRef<string | null>(null);
  const releaseFlight = useCallback((): void => {
    flightAcquiredRef.current = false;
    setPending(null);
  }, []);
  const { stageMutation, resetMutation } = useIndexMutations(
    setError,
    conflictWarnPathRef,
    releaseFlight,
  );
  const stageMutate = stageMutation.mutate;
  const resetMutate = resetMutation.mutate;
  const acquireFlight = useCallback((action: GitFileIndexAction, filePath: string): boolean => {
    if (flightAcquiredRef.current) return false;
    flightAcquiredRef.current = true;
    setError(null);
    setPending({ action, filePath });
    return true;
  }, []);

  const stage = useCallback(
    (filePath: string, options?: StageFileOptions): void => {
      // Without the prefix an open Editor buffer cannot be matched, so a
      // dirty one could be staged from stale disk content.
      const kind =
        gitPrefix == null
          ? "root-loading"
          : hasDirtyEditorBuffer(featureId, filePath, gitPrefix)
            ? "dirty-buffer"
            : null;
      if (kind != null) {
        const blocked: IndexFailure = { action: "stage", filePath, kind };
        setError(blocked);
        const message = indexFailureMessage(blocked, translateUi);
        toast.error(
          translateUi(
            "workspace.git.useGitFileIndexActions.couldNotStagePath",
            "Could not stage {{path}}",
            { path: displayGitPath(filePath) },
          ),
          { description: message },
        );
        return;
      }
      if (!acquireFlight("stage", filePath)) return;
      conflictWarnPathRef.current = options?.conflicted ? filePath : null;
      stageMutate({ data: { feature_id: featureId, file_path: filePath } });
    },
    [acquireFlight, featureId, gitPrefix, stageMutate],
  );
  const reset = useCallback(
    (filePath: string): void => {
      if (!acquireFlight("reset", filePath)) return;
      resetMutate({ data: { feature_id: featureId, file_path: filePath } });
    },
    [acquireFlight, featureId, resetMutate],
  );

  const isPending = pending !== null;
  const pendingAction = pending?.action ?? null;
  const pendingPath = pending?.filePath ?? null;

  return useMemo(
    () => ({ stage, reset, isPending, pendingAction, pendingPath, error }),
    [error, isPending, pendingAction, pendingPath, reset, stage],
  );
}

function useIndexMutations(
  setError: (error: IndexFailure | null) => void,
  conflictWarnPathRef: { current: string | null },
  releaseFlight: () => void,
) {
  const stageMutation = useStageFile({
    mutation: {
      onSuccess: (_response, variables) => {
        setError(null);
        const path = variables.data.file_path;
        if (conflictWarnPathRef.current === path) {
          toast.warning(
            translateUi(
              "workspace.git.useGitFileIndexActions.stagedPathWithConflicts",
              "Staged {{path}} with conflicts",
              { path: displayGitPath(path) },
            ),
            {
              description: translateUi(
                "workspace.git.useGitFileIndexActions.confirmConflictMarkersAreResolvedBeforeContinuing",
                "Confirm conflict markers are resolved before continuing the merge.",
              ),
            },
          );
        }
        conflictWarnPathRef.current = null;
      },
      onError: (mutationError, variables) => {
        conflictWarnPathRef.current = null;
        const failure: IndexFailure = {
          action: "stage",
          filePath: variables.data.file_path,
          kind: "backend",
          rawMessage: apiErrorMessage(mutationError, ""),
        };
        setError(failure);
        const message = indexFailureMessage(failure, translateUi);
        toast.error(
          translateUi(
            "workspace.git.useGitFileIndexActions.couldNotStagePath",
            "Could not stage {{path}}",
            { path: displayGitPath(variables.data.file_path) },
          ),
          {
            description: message,
          },
        );
      },
      onSettled: releaseFlight,
    },
  });
  const resetMutation = useResetFile({
    mutation: {
      onSuccess: () => {
        setError(null);
      },
      onError: (mutationError, variables) => {
        const failure: IndexFailure = {
          action: "reset",
          filePath: variables.data.file_path,
          kind: "backend",
          rawMessage: apiErrorMessage(mutationError, ""),
        };
        setError(failure);
        const message = indexFailureMessage(failure, translateUi);
        toast.error(
          translateUi(
            "workspace.git.useGitFileIndexActions.couldNotUnstagePath",
            "Could not unstage {{path}}",
            { path: displayGitPath(variables.data.file_path) },
          ),
          {
            description: message,
          },
        );
      },
      onSettled: releaseFlight,
    },
  });
  return { stageMutation, resetMutation };
}

function indexFailureMessage(failure: IndexFailure, t: UiTranslator): string {
  switch (failure.kind) {
    case "root-loading":
      return t(
        "workspace.git.useGitFileIndexActions.theProjectSGitRootIsStillLoading",
        "The project's Git root is still loading; try again.",
      );
    case "dirty-buffer":
      return t(
        "workspace.git.useGitFileIndexActions.saveTheOpenEditorBufferBeforeStaging",
        "Save the open Editor buffer before staging this file.",
      );
    case "backend":
      return (
        failure.rawMessage ||
        (failure.action === "stage"
          ? t(
              "workspace.git.useGitFileIndexActions.gitCouldNotStageThisPath",
              "Git could not stage this path",
            )
          : t(
              "workspace.git.useGitFileIndexActions.gitCouldNotUnstageThisPath",
              "Git could not unstage this path",
            ))
      );
  }
}
