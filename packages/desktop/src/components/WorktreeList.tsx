import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Trash2, GitBranch, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  type ProjectWorktreeInfo,
  useListProjectWorktrees,
  useDeleteWorktree,
  useRemoveOrphanWorktree,
  getListProjectWorktreesQueryKey,
} from "@/api/generated";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { apiErrorMessage } from "@/lib/api-errors";

type Worktree = ProjectWorktreeInfo;

function createMutationCallbacks(queryClient: QueryClient, projectId: number) {
  return {
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: getListProjectWorktreesQueryKey({ project_id: projectId }),
      });
    },
    onError: (error: unknown) => {
      toast.error(
        apiErrorMessage(
          error,
          translateUi("project.worktreeList.failedToRemoveWorktree", "Failed to remove worktree"),
        ),
      );
    },
  };
}

interface WorktreeRowProps {
  worktree: Worktree;
  deleting: boolean;
  confirming: boolean;
  blocked: boolean;
  onDelete: (worktree: Worktree) => void;
  onForceDelete: (worktree: Worktree) => void;
  onBlockedChange: (blocked: boolean) => void;
}

function WorktreeRow({
  worktree,
  deleting,
  confirming,
  blocked,
  onDelete,
  onForceDelete,
  onBlockedChange,
}: WorktreeRowProps) {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{worktree.branch}</div>
        <div className="truncate text-[11px] font-mono text-muted-foreground/70">
          {worktree.path}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {worktree.feature_title ? (
            <span>
              {worktree.feature_title}
              <Badge
                variant="outline"
                className={`ml-2 px-1 py-0 text-[10px] ${
                  worktree.feature_status === "active"
                    ? "border-[var(--acc-green)]/40 text-[var(--acc-green)]"
                    : "border-amber-500/45 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
              >
                {worktree.feature_status === "active"
                  ? t("project.worktreeList.activeFeature", "Active feature")
                  : t("project.worktreeList.archivedFeature", "Archived feature")}
              </Badge>
            </span>
          ) : (
            <span className="italic">
              {t("project.worktreeList.noLinkedFeature", "No linked feature")}
            </span>
          )}
        </div>
      </div>
      {deleting ? (
        <div className="flex h-6 w-6 shrink-0 items-center justify-center">
          <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      ) : (
        <Popover open={blocked} onOpenChange={onBlockedChange}>
          <PopoverTrigger asChild>
            <Button
              variant={confirming ? "destructive" : "ghost"}
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={() => onDelete(worktree)}
              title={
                confirming
                  ? t("project.worktreeList.clickAgainToConfirm", "Click again to confirm")
                  : t("project.worktreeList.removeWorktree", "Remove worktree")
              }
            >
              {blocked ? <AlertTriangle className="size-3" /> : <Trash2 className="size-3" />}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-3 text-xs">
            <div className="font-medium text-foreground">
              {t("project.worktreeList.worktreeHasLocalChanges", "Worktree has local changes")}
            </div>
            <p className="text-muted-foreground">
              {t(
                "project.worktreeList.dirtyWorktreeDescription",
                "Git refused to remove this worktree because it has uncommitted or untracked files. You can force removal if you are sure those files can be discarded.",
              )}
            </p>
            <Button variant="destructive" size="sm" onClick={() => onForceDelete(worktree)}>
              {t("project.worktreeList.forceRemoveWorktree", "Force remove worktree")}
            </Button>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function WorktreeList({ projectId }: { projectId: number }) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const { data: worktrees, isLoading } = useListProjectWorktrees({ project_id: projectId });
  const mutationCallbacks = createMutationCallbacks(queryClient, projectId);
  const deleteWorktree = useDeleteWorktree({ mutation: mutationCallbacks });
  const removeOrphan = useRemoveOrphanWorktree({ mutation: mutationCallbacks });

  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  const [blockedPath, setBlockedPath] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
        {t("project.worktreeList.loadingWorktrees", "Loading worktrees…")}
      </div>
    );
  }

  if (!worktrees?.length) {
    return (
      <p className="py-3 text-center text-xs text-muted-foreground">
        {t("project.worktreeList.noWorktrees", "No worktrees")}
      </p>
    );
  }

  function removeWorktree(wt: NonNullable<typeof worktrees>[number], force: boolean): void {
    setDeletingPaths((prev) => new Set(prev).add(wt.path));
    const onSettled = () =>
      setDeletingPaths((prev) => {
        const next = new Set(prev);
        next.delete(wt.path);
        return next;
      });
    const onSuccess = (result: {
      success: boolean;
      error?: string | null;
      blocked_reason?: string | null;
    }) => {
      if (result.success) return;
      if (result.blocked_reason === "dirty_worktree") {
        setBlockedPath(wt.path);
      } else {
        toast.error(
          result.error ??
            translateUi("project.worktreeList.failedToRemoveWorktree", "Failed to remove worktree"),
        );
      }
    };
    if (wt.feature_id) {
      deleteWorktree.mutate(
        { params: { project_id: projectId, feature_id: wt.feature_id, force } },
        { onSuccess, onSettled },
      );
    } else {
      removeOrphan.mutate(
        { data: { project_id: projectId, worktree_path: wt.path, force } },
        { onSuccess, onSettled },
      );
    }
  }

  function handleDelete(wt: NonNullable<typeof worktrees>[number]): void {
    if (confirmPath !== wt.path) {
      setConfirmPath(wt.path);
      return;
    }
    setConfirmPath(null);
    removeWorktree(wt, false);
  }

  function forceDelete(wt: NonNullable<typeof worktrees>[number]): void {
    setBlockedPath(null);
    removeWorktree(wt, true);
  }

  return (
    // A phone scrolls the page it sits in, never a box inside it.
    <div className="max-h-[240px] space-y-1 overflow-y-auto pr-1 phone:max-h-none phone:overflow-visible phone:pr-0">
      {worktrees.map((wt) => (
        <WorktreeRow
          key={wt.path}
          worktree={wt}
          deleting={deletingPaths.has(wt.path)}
          confirming={confirmPath === wt.path}
          blocked={blockedPath === wt.path}
          onDelete={handleDelete}
          onForceDelete={forceDelete}
          onBlockedChange={(nextBlocked) => !nextBlocked && setBlockedPath(null)}
        />
      ))}
    </div>
  );
}
