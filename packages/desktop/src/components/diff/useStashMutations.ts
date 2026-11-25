import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  useApplyStash,
  useDropStash,
  usePopStash,
  type GitOperationResponse,
  type StashEntry,
  type StashMutationBody,
} from "@/api/generated";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import type {
  ConflictableStashOperation,
  StashConflictHandler,
  StashConflictOpenHandler,
  StashConflictOutcome,
  StashMutationOperation,
} from "./stash-contracts";
import type { StashMutationCoordinator, StashMutationLease } from "./useStashMutationCoordinator";

type StashMutationExecutor = (variables: {
  data: StashMutationBody;
}) => Promise<GitOperationResponse>;

interface UseStashMutationsOptions {
  featureId: number;
  stash: StashEntry;
  onConflicts?: StashConflictHandler;
  onOpenConflict?: StashConflictOpenHandler;
  onRefresh?: () => Promise<void>;
  coordinator: StashMutationCoordinator;
}

export interface StashMutationController {
  pendingOperation: StashMutationOperation | null;
  apply: () => Promise<boolean>;
  pop: () => Promise<boolean>;
  drop: () => Promise<boolean>;
}

const stashOperationCopy = {
  apply: {
    success: (ref: string) =>
      translateUi("workspace.git.useStashMutations.applySucceeded", "Applied {{ref}}", { ref }),
    failure: (ref: string) =>
      translateUi("workspace.git.useStashMutations.applyFailed", "Could not apply {{ref}}.", {
        ref,
      }),
    stale: () =>
      translateUi(
        "workspace.git.useStashMutations.applyStale",
        "Applied stash, but could not refresh the list",
      ),
  },
  pop: {
    success: (ref: string) =>
      translateUi("workspace.git.useStashMutations.popSucceeded", "Popped {{ref}}", { ref }),
    failure: (ref: string) =>
      translateUi("workspace.git.useStashMutations.popFailed", "Could not pop {{ref}}.", { ref }),
    stale: () =>
      translateUi(
        "workspace.git.useStashMutations.popStale",
        "Popped stash, but could not refresh the list",
      ),
  },
  drop: {
    success: (ref: string) =>
      translateUi("workspace.git.useStashMutations.dropSucceeded", "Dropped {{ref}}", { ref }),
    failure: (ref: string) =>
      translateUi("workspace.git.useStashMutations.dropFailed", "Could not drop {{ref}}.", { ref }),
    stale: () =>
      translateUi(
        "workspace.git.useStashMutations.dropStale",
        "Dropped stash, but could not refresh the list",
      ),
  },
} satisfies Record<
  StashMutationOperation,
  {
    success: (ref: string) => string;
    failure: (ref: string) => string;
    stale: () => string;
  }
>;

function conflictOutcome(
  operation: ConflictableStashOperation,
  stash: StashEntry,
  conflictFiles: string[],
): StashConflictOutcome {
  return { operation, stash, conflictFiles };
}

function showConflictToast(
  outcome: StashConflictOutcome,
  onOpenConflict: StashConflictOpenHandler | undefined,
): void {
  const firstConflict = outcome.conflictFiles[0];
  const action =
    firstConflict && onOpenConflict
      ? {
          label: translateUi(
            "workspace.git.useStashMutations.openFirstConflict",
            "Open first conflict",
          ),
          onClick: () => onOpenConflict(firstConflict),
        }
      : undefined;
  const retention =
    outcome.operation === "pop"
      ? translateUi(
          "workspace.git.useStashMutations.retainedAfterPop",
          "{{ref}} was kept because the pop conflicted.",
          { ref: outcome.stash.ref_name },
        )
      : translateUi(
          "workspace.git.useStashMutations.retainedAfterApply",
          "{{ref}} remains available after the conflicted apply.",
          { ref: outcome.stash.ref_name },
        );
  const fileList = outcome.conflictFiles.join(", ");

  toast.warning(
    outcome.operation === "pop"
      ? translateUi("workspace.git.useStashMutations.popConflicts", "Stash pop has conflicts")
      : translateUi("workspace.git.useStashMutations.applyConflicts", "Stash apply has conflicts"),
    {
      description: fileList
        ? translateUi(
            "workspace.git.useStashMutations.conflictFiles",
            "{{retention}} Conflicts: {{files}}",
            { retention, files: fileList },
          )
        : retention,
      action,
      duration: 12_000,
    },
  );
}

export function useStashMutations({
  featureId,
  stash,
  onConflicts,
  onOpenConflict,
  onRefresh,
  coordinator,
}: UseStashMutationsOptions): StashMutationController {
  const applyMutation = useApplyStash();
  const popMutation = usePopStash();
  const dropMutation = useDropStash();
  const selector = useMemo<StashMutationBody>(
    () => ({ feature_id: featureId, ref_name: stash.ref_name, expected_sha: stash.sha }),
    [featureId, stash.ref_name, stash.sha],
  );

  const refreshAfterMutation = useCallback(
    async (operation: StashMutationOperation): Promise<void> => {
      if (!onRefresh) return;
      try {
        await onRefresh();
      } catch (error) {
        toast.error(stashOperationCopy[operation].stale(), {
          description: apiErrorMessage(
            error,
            translateUi(
              "workspace.git.useStashMutations.theStashListMayBeStale",
              "The stash list may be stale.",
            ),
          ),
        });
      }
    },
    [onRefresh],
  );

  const execute = useCallback(
    async (operation: StashMutationOperation, mutate: StashMutationExecutor): Promise<boolean> => {
      const lease: StashMutationLease | null = coordinator.tryAcquire({
        kind: "row",
        operation,
        stashRefName: stash.ref_name,
      });
      if (!lease) return false;
      try {
        const result = await mutate({ data: selector });
        if (result.outcome === "conflicts") {
          if (operation === "drop") {
            toast.error(
              translateUi(
                "workspace.git.useStashMutations.dropStashReturnedAnUnexpectedConflictOutcome",
                "Drop stash returned an unexpected conflict outcome",
              ),
              {
                description: result.conflict_files.join(", "),
              },
            );
            return false;
          }
          const outcome = conflictOutcome(operation, stash, result.conflict_files);
          onConflicts?.(outcome);
          showConflictToast(outcome, onOpenConflict);
        } else {
          toast.success(stashOperationCopy[operation].success(stash.ref_name));
        }
        await refreshAfterMutation(operation);
        return true;
      } catch (error) {
        toastError(error, stashOperationCopy[operation].failure(stash.ref_name));
        return false;
      } finally {
        coordinator.release(lease);
      }
    },
    [coordinator, onConflicts, onOpenConflict, refreshAfterMutation, selector, stash],
  );

  const apply = useCallback(
    (): Promise<boolean> => execute("apply", applyMutation.mutateAsync),
    [applyMutation.mutateAsync, execute],
  );
  const pop = useCallback(
    (): Promise<boolean> => execute("pop", popMutation.mutateAsync),
    [execute, popMutation.mutateAsync],
  );
  const drop = useCallback(
    (): Promise<boolean> => execute("drop", dropMutation.mutateAsync),
    [dropMutation.mutateAsync, execute],
  );

  const pendingOperation =
    coordinator.activeMutation?.kind === "row" &&
    coordinator.activeMutation.stashRefName === stash.ref_name
      ? coordinator.activeMutation.operation
      : null;

  return useMemo(
    () => ({ pendingOperation, apply, pop, drop }),
    [apply, drop, pendingOperation, pop],
  );
}
