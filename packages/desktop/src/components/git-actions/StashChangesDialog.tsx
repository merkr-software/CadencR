import { useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import { toast } from "sonner";

import {
  getListStashesQueryKey,
  useGetUncommittedFiles,
  usePushStash,
  type UncommittedFile,
} from "@/api/generated";
import { useStashMutationCoordinator } from "@/components/diff/useStashMutationCoordinator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import { StashChangesDialogBody, type StashDialogViewModel } from "./StashChangesDialogBody";
import { useStashDialogShortcuts } from "./useStashDialogShortcuts";

export interface StashChangesDialogProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Controlled stash-push dialog. Backend/query state remains authoritative. */
const StashChangesDialog = memo(function StashChangesDialog({
  featureId,
  open,
  onOpenChange,
}: StashChangesDialogProps): ReactElement {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const filesQuery = useGetUncommittedFiles(
    { feature_id: featureId },
    { query: { enabled: open } },
  );
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);
  const submission = useStashPushSubmission({
    featureId,
    files,
    filesReady: !filesQuery.isLoading && !filesQuery.isError,
    open,
    onOpenChange,
  });
  useStashDialogShortcuts({
    canSubmit: submission.canSubmit,
    enabled: open && !submission.pending,
    nameInputRef,
    onConfirm: submission.handleConfirm,
    onToggle: submission.handleToggleUntracked,
  });

  return (
    <Dialog open={open} onOpenChange={submission.handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[min(90vh,var(--dialog-max-h))] gap-0 p-0 shadow-xl !w-[min(92vw,46rem)] !max-w-[min(92vw,46rem)] sm:!max-w-[min(92vw,46rem)]"
        aria-busy={submission.pending}
      >
        <form onSubmit={submission.handleSubmit} className="grid min-h-0">
          <DialogHeader className="border-b border-border/70 bg-card/40 px-6 py-5">
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Archive aria-hidden="true" className="size-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <DialogTitle>Stash changes</DialogTitle>
                <DialogDescription>
                  Save your current work without committing it. Ignored files always stay in the
                  worktree.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <StashChangesDialogBody
            submission={submission}
            files={files}
            loading={filesQuery.isLoading}
            error={filesQuery.isError ? filesQuery.error : null}
            nameInputRef={nameInputRef}
            onOpenChange={onOpenChange}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
});

interface StashPushSubmissionOptions extends StashChangesDialogProps {
  files: UncommittedFile[];
  filesReady: boolean;
}

interface StashPushSubmissionController extends StashDialogViewModel {
  handleConfirm: () => Promise<void>;
  handleOpenChange: (open: boolean) => void;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

function useStashPushSubmission({
  featureId,
  files,
  filesReady,
  open,
  onOpenChange,
}: StashPushSubmissionOptions): StashPushSubmissionController {
  const { name, includeUntracked, setName, setIncludeUntracked } = useStashFormState(open);
  const [responseError, setResponseError] = useState<string | null>(null);
  const pushStash = usePushStash();
  const coordinator = useStashMutationCoordinator(featureId);
  const refreshStashes = useRefreshStashes(featureId);
  const resetPushStash = pushStash.reset;
  const ownsPush = coordinator.activeMutation?.kind === "push";
  const pending = ownsPush || pushStash.isPending;
  const blockedReason = ownsPush ? null : coordinator.blockedReason;
  const error =
    responseError ??
    (pushStash.error ? apiErrorMessage(pushStash.error, "Could not stash changes.") : null);
  const hasStashable = useHasStashableChanges(files, includeUntracked);
  const canSubmit = filesReady && hasStashable && !pending && !blockedReason;

  useEffect(() => {
    if (open) return;
    setResponseError(null);
    resetPushStash();
  }, [open, resetPushStash]);

  const handleNameChange = useCallback((nextName: string): void => setName(nextName), []);
  const handleToggleUntracked = useCallback((): void => {
    if (!pending) setIncludeUntracked((current) => !current);
  }, [pending]);
  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (!pending) onOpenChange(nextOpen);
    },
    [onOpenChange, pending],
  );
  const handleConfirm = useCallback(async (): Promise<void> => {
    await submitStashPush({
      canSubmit,
      coordinator,
      featureId,
      includeUntracked,
      name,
      onOpenChange,
      pushStash: pushStash.mutateAsync,
      refreshStashes,
      setResponseError,
    });
  }, [
    canSubmit,
    coordinator,
    featureId,
    includeUntracked,
    name,
    onOpenChange,
    pushStash.mutateAsync,
    refreshStashes,
  ]);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      await handleConfirm();
    },
    [handleConfirm],
  );

  return useMemo(
    () => ({
      name,
      includeUntracked,
      error,
      blockedReason,
      pending,
      canSubmit,
      handleNameChange,
      handleToggleUntracked,
      handleConfirm,
      handleOpenChange,
      handleSubmit,
    }),
    [
      blockedReason,
      canSubmit,
      error,
      handleNameChange,
      handleConfirm,
      handleOpenChange,
      handleSubmit,
      handleToggleUntracked,
      includeUntracked,
      name,
      pending,
    ],
  );
}

interface SubmitStashPushOptions {
  canSubmit: boolean;
  coordinator: ReturnType<typeof useStashMutationCoordinator>;
  featureId: number;
  includeUntracked: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  pushStash: ReturnType<typeof usePushStash>["mutateAsync"];
  refreshStashes: () => Promise<void>;
  setResponseError: (error: string | null) => void;
}

async function submitStashPush(options: SubmitStashPushOptions): Promise<void> {
  if (!options.canSubmit) return;
  options.setResponseError(null);
  const lease = options.coordinator.tryAcquire({ kind: "push" });
  if (!lease) {
    options.setResponseError(
      options.coordinator.getBlockedReason() ?? "Another stash operation is in progress",
    );
    return;
  }
  const submittedName = options.name.trim() || null;
  try {
    const result = await options.pushStash({
      data: {
        feature_id: options.featureId,
        message: submittedName,
        include_untracked: options.includeUntracked,
      },
    });
    if (result.outcome === "conflicts") {
      options.setResponseError(
        `Stash creation unexpectedly reported conflicts: ${result.conflict_files.join(", ")}`,
      );
      return;
    }
    await options.refreshStashes();
    toast.success(submittedName ? `Stashed changes as “${submittedName}”` : "Stashed changes");
    options.onOpenChange(false);
  } catch {
    // React Query retains the generated mutation error for the inline alert.
  } finally {
    options.coordinator.release(lease);
  }
}

interface StashFormState {
  name: string;
  includeUntracked: boolean;
  setName: Dispatch<SetStateAction<string>>;
  setIncludeUntracked: Dispatch<SetStateAction<boolean>>;
}

function useStashFormState(open: boolean): StashFormState {
  const [name, setName] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  useEffect(() => {
    if (open) return;
    setName("");
    setIncludeUntracked(false);
  }, [open]);
  return useMemo(
    () => ({
      name,
      includeUntracked,
      setName,
      setIncludeUntracked,
    }),
    [includeUntracked, name],
  );
}

function useRefreshStashes(featureId: number): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async (): Promise<void> => {
    try {
      await queryClient.invalidateQueries({
        queryKey: getListStashesQueryKey({ feature_id: featureId }),
        exact: true,
      });
    } catch (caught) {
      toast.error("Stashed changes, but could not refresh the stash list", {
        description: apiErrorMessage(caught, "The stash list may be stale."),
      });
    }
  }, [featureId, queryClient]);
}

function useHasStashableChanges(files: UncommittedFile[], includeUntracked: boolean): boolean {
  return useMemo(
    () => files.some((file) => file.status !== "untracked" || includeUntracked),
    [files, includeUntracked],
  );
}

export default StashChangesDialog;
