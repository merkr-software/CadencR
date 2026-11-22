import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  useCheckBranchDelete,
  useGetGitStatus,
  type BranchDeleteCheckResponse,
  type Feature,
  type GitStatusSnapshot,
} from "@/api/generated";

interface ArchiveCleanupStateArgs {
  open: boolean;
  feature: Feature | undefined;
  projectId: number;
  hasLiveWorktree: boolean;
  hasResidualWorktreeDirectory: boolean;
  showWorktreeRemoval: boolean;
  showBranchRemoval: boolean;
}

interface ArchiveCleanupState {
  showWorktreeRemoval: boolean;
  showBranchRemoval: boolean;
  removeWorktree: boolean;
  removeBranch: boolean;
  branchRemovalDisabled: boolean;
  noWorktreeBranchMode: boolean;
  isCheckingBranchRemovalSafety: boolean;
  isRemovingDefaultBranch: boolean;
  defaultBranch: string;
  isRemovingTargetBranch: boolean;
  branchCheckReady: boolean;
  branchName: string;
  targetBranch: string;
  forceBranchDelete: boolean;
  forceWorktreeDelete: boolean;
  isCheckingWorktree: boolean;
  isCheckingBranch: boolean;
  gitStatusError: unknown;
  branchCheckError: unknown;
  toggleWorktree: () => void;
  toggleBranch: () => void;
}

export function useArchiveCleanupState(args: ArchiveCleanupStateArgs): ArchiveCleanupState {
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [removeBranch, setRemoveBranch] = useState(false);
  const { branchCheck, gitStatus, noWorktreeBranchMode } = useArchiveCleanupQueries(
    args,
    removeWorktree,
    removeBranch,
  );
  const branchSafety = getBranchCleanupSafety({
    data: branchCheck.data,
    isLoading: branchCheck.isLoading,
    noWorktreeBranchMode,
    removeBranch,
  });
  const isCheckingWorktree = removeWorktree && args.hasLiveWorktree && gitStatus.isLoading;
  const forceWorktreeDelete =
    removeWorktree &&
    (args.hasResidualWorktreeDirectory ||
      (args.hasLiveWorktree && isDirtyGitStatus(gitStatus.data)));

  const controls = useCleanupSelectionControls({
    open: args.open,
    showWorktreeRemoval: args.showWorktreeRemoval,
    showBranchRemoval: args.showBranchRemoval,
    branchRemovalDisabled: branchSafety.branchRemovalDisabled,
    removeWorktree,
    removeBranch,
    setRemoveWorktree,
    setRemoveBranch,
  });

  return useMemo(
    () => ({
      showWorktreeRemoval: args.showWorktreeRemoval,
      showBranchRemoval: args.showBranchRemoval,
      removeWorktree,
      removeBranch,
      branchRemovalDisabled: branchSafety.branchRemovalDisabled,
      noWorktreeBranchMode,
      isCheckingBranchRemovalSafety: branchSafety.isCheckingBranchRemovalSafety,
      isRemovingDefaultBranch: branchSafety.isRemovingDefaultBranch,
      defaultBranch: branchSafety.defaultBranch,
      isRemovingTargetBranch: branchSafety.isRemovingTargetBranch,
      branchCheckReady: branchSafety.branchCheckReady,
      branchName: branchSafety.branchName,
      targetBranch: branchSafety.targetBranch,
      forceBranchDelete: branchSafety.forceBranchDelete,
      forceWorktreeDelete,
      isCheckingWorktree,
      isCheckingBranch: removeBranch && branchCheck.isLoading,
      gitStatusError:
        removeWorktree && args.hasLiveWorktree && gitStatus.isError ? gitStatus.error : null,
      branchCheckError: branchCheck.isError ? branchCheck.error : null,
      toggleWorktree: controls.toggleWorktree,
      toggleBranch: controls.toggleBranch,
    }),
    [
      args.hasLiveWorktree,
      args.showWorktreeRemoval,
      args.showBranchRemoval,
      removeWorktree,
      removeBranch,
      branchSafety.branchRemovalDisabled,
      noWorktreeBranchMode,
      branchSafety.isCheckingBranchRemovalSafety,
      branchSafety.isRemovingDefaultBranch,
      branchSafety.defaultBranch,
      branchSafety.isRemovingTargetBranch,
      branchSafety.branchCheckReady,
      branchSafety.branchName,
      branchSafety.targetBranch,
      branchSafety.forceBranchDelete,
      branchCheck.isError,
      branchCheck.error,
      branchCheck.isLoading,
      forceWorktreeDelete,
      isCheckingWorktree,
      gitStatus.isError,
      gitStatus.error,
      controls.toggleWorktree,
      controls.toggleBranch,
    ],
  );
}

interface ArchiveCleanupQueries {
  branchCheck: QueryState<BranchDeleteCheckResponse>;
  gitStatus: QueryState<GitStatusSnapshot>;
  noWorktreeBranchMode: boolean;
}

interface QueryState<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

function useArchiveCleanupQueries(
  args: ArchiveCleanupStateArgs,
  removeWorktree: boolean,
  removeBranch: boolean,
): ArchiveCleanupQueries {
  const noWorktreeBranchMode = args.showBranchRemoval && !args.showWorktreeRemoval;
  const branchCheck = useCheckBranchDelete<BranchDeleteCheckResponse>(
    { project_id: args.projectId, feature_id: args.feature?.id ?? 0 },
    {
      query: {
        enabled:
          args.open &&
          args.showBranchRemoval &&
          args.feature != null &&
          (removeBranch || noWorktreeBranchMode),
        retry: false,
      },
    },
  );
  const gitStatus = useGetGitStatus<GitStatusSnapshot>(
    { feature_id: args.feature?.id ?? 0 },
    {
      query: {
        enabled: args.open && args.hasLiveWorktree && args.feature != null && removeWorktree,
        retry: false,
      },
    },
  );

  return { branchCheck, gitStatus, noWorktreeBranchMode };
}

interface BranchCleanupSafetyArgs {
  data: BranchDeleteCheckResponse | undefined;
  isLoading: boolean;
  noWorktreeBranchMode: boolean;
  removeBranch: boolean;
}

interface BranchCleanupSafety {
  branchRemovalDisabled: boolean;
  isCheckingBranchRemovalSafety: boolean;
  isRemovingDefaultBranch: boolean;
  defaultBranch: string;
  isRemovingTargetBranch: boolean;
  branchCheckReady: boolean;
  branchName: string;
  targetBranch: string;
  forceBranchDelete: boolean;
}

function getBranchCleanupSafety(args: BranchCleanupSafetyArgs): BranchCleanupSafety {
  const currentBranch = args.data?.current_branch ?? null;
  const targetBranch = args.data?.target_branch ?? "target branch";
  const isRemovingTargetBranch =
    args.noWorktreeBranchMode && currentBranch != null && currentBranch === targetBranch;
  const isCheckingBranchRemovalSafety = args.noWorktreeBranchMode && args.isLoading;
  const isRemovingDefaultBranch = args.data?.is_default_branch ?? false;

  return {
    branchRemovalDisabled:
      isRemovingDefaultBranch || isRemovingTargetBranch || isCheckingBranchRemovalSafety,
    isCheckingBranchRemovalSafety,
    isRemovingDefaultBranch,
    defaultBranch: args.data?.default_branch ?? "default branch",
    isRemovingTargetBranch,
    branchCheckReady: args.data != null,
    branchName: args.data?.branch ?? "feature branch",
    targetBranch,
    forceBranchDelete: args.removeBranch && !(args.data?.merged ?? true),
  };
}

interface CleanupSelectionControlArgs {
  open: boolean;
  showWorktreeRemoval: boolean;
  showBranchRemoval: boolean;
  branchRemovalDisabled: boolean;
  removeWorktree: boolean;
  removeBranch: boolean;
  setRemoveWorktree: Dispatch<SetStateAction<boolean>>;
  setRemoveBranch: Dispatch<SetStateAction<boolean>>;
}

interface CleanupSelectionControls {
  toggleWorktree: () => void;
  toggleBranch: () => void;
}

function useCleanupSelectionControls({
  open,
  showWorktreeRemoval,
  showBranchRemoval,
  branchRemovalDisabled,
  removeWorktree,
  removeBranch,
  setRemoveWorktree,
  setRemoveBranch,
}: CleanupSelectionControlArgs): CleanupSelectionControls {
  useEffect(() => {
    if (!open) {
      setRemoveWorktree(false);
      setRemoveBranch(false);
    }
  }, [open, setRemoveBranch, setRemoveWorktree]);

  useEffect(() => {
    if (removeBranch && (!showBranchRemoval || branchRemovalDisabled)) setRemoveBranch(false);
  }, [branchRemovalDisabled, removeBranch, setRemoveBranch, showBranchRemoval]);

  const toggleWorktree = useCallback((): void => {
    if (!showWorktreeRemoval) return;
    if (removeWorktree && removeBranch) return;
    setRemoveWorktree((value) => !value);
  }, [removeBranch, removeWorktree, setRemoveWorktree, showWorktreeRemoval]);

  const toggleBranch = useCallback((): void => {
    if (!showBranchRemoval || branchRemovalDisabled) return;
    setRemoveBranch((value) => {
      const next = !value;
      if (next && showWorktreeRemoval) setRemoveWorktree(true);
      return next;
    });
  }, [
    branchRemovalDisabled,
    setRemoveBranch,
    setRemoveWorktree,
    showBranchRemoval,
    showWorktreeRemoval,
  ]);

  return useMemo(() => ({ toggleWorktree, toggleBranch }), [toggleWorktree, toggleBranch]);
}

function isDirtyGitStatus(status: GitStatusSnapshot | undefined): boolean {
  if (!status) return false;
  return (
    status.uncommitted_count > 0 ||
    status.staged_count > 0 ||
    status.unstaged_count > 0 ||
    status.untracked_count > 0
  );
}
