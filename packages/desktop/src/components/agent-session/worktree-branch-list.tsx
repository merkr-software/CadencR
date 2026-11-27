import { useUiTranslation } from "@/lib/i18n/ui";
import { CheckIcon, GitBranchIcon, Loader2 } from "lucide-react";
import type { ReactElement } from "react";
import type { BranchInfo } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

interface BranchListProps {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  list: ReactElement;
}

export function BranchList({ isLoading, isError, error, list }: BranchListProps): ReactElement {
  const { t } = useUiTranslation();
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{t("conversation.stream.worktreePopover.loadingBranches", "Loading branches…")}</span>
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-destructive p-3">
        {apiErrorMessage(
          error,
          t("conversation.stream.worktreePopover.failedToLoadBranches", "Failed to load branches."),
        )}
      </p>
    );
  }
  return list;
}

interface BranchRowProps {
  branch: BranchInfo;
  isActive: boolean;
  isDefault: boolean;
  isSelected: boolean;
  onPick: (branch: BranchInfo) => void;
}

export function BranchRow({
  branch,
  isActive,
  isDefault,
  isSelected,
  onPick,
}: BranchRowProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={() => onPick(branch)}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent",
        isSelected && "bg-accent/50",
        isActive && "bg-accent",
      )}
    >
      {/* Leading worktree icon mirrors the sidebar's "has worktree" affordance.
          Picking such a branch steers the mode to reuse its worktree. */}
      {branch.attached_worktree_path ? (
        <GitBranchIcon
          className="size-3 shrink-0 text-[var(--chip-worktree-fg)]"
          aria-label={t("conversation.stream.worktreePopover.hasWorktree", "Has worktree")}
        />
      ) : (
        <span className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1 truncate font-mono text-xs">{branch.name}</span>
      {isDefault && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          {t("conversation.stream.worktreePopover.default", "default")}
        </span>
      )}
      {!branch.is_local && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          {t("conversation.stream.worktreePopover.remote", "remote")}
        </span>
      )}
      {branch.attached_feature_id != null && (
        <span className="text-[10px] text-muted-foreground">
          {t("conversation.stream.worktreePopover.inUseByFeature", "in use by feature #{{id}}", {
            id: branch.attached_feature_id,
          })}
        </span>
      )}
      {isSelected && <CheckIcon className="size-3 shrink-0 text-[var(--chip-worktree-fg)]" />}
    </button>
  );
}
