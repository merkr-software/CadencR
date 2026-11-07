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

export type GitFileIndexAction = "stage" | "reset";

export interface GitFileIndexError {
  action: GitFileIndexAction;
  filePath: string;
  message: string;
}

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
  const [error, setError] = useState<GitFileIndexError | null>(null);
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
  const stageMutation = useStageFile({
    mutation: {
      onSuccess: (_response, variables) => {
        setError(null);
        const path = variables.data.file_path;
        if (conflictWarnPathRef.current === path) {
          toast.warning(`Staged ${path} with conflicts`, {
            description: "Confirm conflict markers are resolved before continuing the merge.",
          });
        }
        conflictWarnPathRef.current = null;
      },
      onError: (mutationError, variables) => {
        conflictWarnPathRef.current = null;
        const message = apiErrorMessage(mutationError, "Git could not stage this path");
        setError({ action: "stage", filePath: variables.data.file_path, message });
        toast.error(`Could not stage ${variables.data.file_path}`, { description: message });
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
        const message = apiErrorMessage(mutationError, "Git could not unstage this path");
        setError({ action: "reset", filePath: variables.data.file_path, message });
        toast.error(`Could not unstage ${variables.data.file_path}`, { description: message });
      },
      onSettled: releaseFlight,
    },
  });
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
      const message =
        gitPrefix == null
          ? "The project's Git root is still loading; try again."
          : hasDirtyEditorBuffer(featureId, filePath, gitPrefix)
            ? "Save the open Editor buffer before staging this file."
            : null;
      if (message != null) {
        setError({ action: "stage", filePath, message });
        toast.error(`Could not stage ${filePath}`, { description: message });
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
