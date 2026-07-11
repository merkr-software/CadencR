/**
 * Pre-first-prompt branch/worktree selector. A segmented chip with two halves:
 *
 *   • Branch chip — picks the branch the behavior applies to. Defaults to the
 *                   project's current branch (`defaultBranch`). The chevron
 *                   opens a virtualized, searchable list. `BranchInfo` carries
 *                   `attached_worktree_path` so we can surface "in use by
 *                   feature #N" inline and steer the mode toward reuse.
 *
 *   • Mode chip   — the explicit behavior (`WorktreeModePicker`): On branch /
 *                   Reuse·New worktree / From branch / From branch with
 *                   worktree. See `lib/worktree-mode` for the full matrix.
 *
 * The chosen `WorktreeMode` + branch are owned by the parent. The route layer
 * resolves them into `worktree_mode` / `worktree_base_branch` /
 * `worktree_reuse_branch` settings (and an optional checkout) before the first
 * `prompt.send` envelope — see `resolveWorktreeChoice` in `lib/worktree-mode`.
 */
import { memo, useCallback, useState, type ReactElement } from "react";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, Loader2 } from "lucide-react";

import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useListBranches, type BranchInfo } from "@/api/generated";
import { useBranchList, type BranchListRowContext } from "@/components/branch-chip/BranchList";
import {
  branchWorktreeState,
  firstPromptBranchEffect,
  isWorktreeModeDisabled,
  type WorktreeMode,
} from "@/lib/worktree-mode";
import { WorktreeModePicker } from "./WorktreeModePicker";
import { WORKTREE_GROUP, WORKTREE_SEGMENT_ACTIVE } from "./meta-bar-chip-styles";
import { SlidingText } from "@/components/SlidingText";

const EMPTY_BRANCHES: BranchInfo[] = [];

interface WorktreeButtonGroupProps {
  projectId: number;
  /**
   * The project's currently checked-out branch — used as the picker's default
   * hint and as the implicit value when nothing is picked. `undefined` while
   * the lookup is in flight.
   */
  defaultBranch: string | undefined;
  /** The project's main working-tree path — a branch already checked out here
   *  can't be reused/worktree'd (git forbids the same branch in two trees). */
  projectPath: string | undefined;
  /** Explicit branch/worktree behavior. */
  mode: WorktreeMode;
  onModeChange: (mode: WorktreeMode) => void;
  /** Picked branch, or `null` when implicitly using `defaultBranch`. */
  selectedBranch: string | null;
  onSelectedBranchChange: (next: string | null) => void;
}

export const WorktreeButtonGroup = memo(function WorktreeButtonGroup({
  projectId,
  defaultBranch,
  projectPath,
  mode,
  onModeChange,
  selectedBranch,
  onSelectedBranchChange,
}: WorktreeButtonGroupProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const branchesQuery = useListBranches(
    { project_id: projectId },
    // Repos can have hundreds of branches — only fetch when the picker opens.
    { query: { enabled: open } },
  );
  const branches = branchesQuery.data ?? EMPTY_BRANCHES;
  const state = branchWorktreeState({ selectedBranch, defaultBranch, branches, projectPath });

  const selectBranch = useCallback(
    (next: string | null) => {
      onSelectedBranchChange(next);
      // Steer the mode so it stays valid for the new branch: an attached
      // branch defaults to reuse; an invalid pick (e.g. switching to the
      // default branch while in `branch_worktree`) falls back to "On branch".
      const nextState = branchWorktreeState({
        selectedBranch: next,
        defaultBranch,
        branches,
        projectPath,
      });
      if (nextState.hasWorktree) {
        onModeChange("branch_worktree");
      } else if (isWorktreeModeDisabled(mode, nextState)) {
        onModeChange("on_branch");
      }
      setOpen(false);
    },
    [branches, defaultBranch, mode, onModeChange, onSelectedBranchChange, projectPath],
  );

  const handlePick = useCallback(
    (branch: BranchInfo) => {
      // Picking the project's current branch is the same as "Project default".
      selectBranch(branch.name === defaultBranch ? null : branch.name);
    },
    [defaultBranch, selectBranch],
  );

  const renderBranchRow = useCallback(
    (ctx: BranchListRowContext) => (
      <BranchRow
        branch={ctx.branch}
        isActive={ctx.isActive}
        isDefault={defaultBranch === ctx.branch.name}
        isSelected={selectedBranch === ctx.branch.name}
        onPick={handlePick}
      />
    ),
    [defaultBranch, handlePick, selectedBranch],
  );
  const branchList = useBranchList({
    branches,
    query,
    onPick: handlePick,
    renderRow: renderBranchRow,
    height: 240,
    emptyState: (
      <p className="text-sm text-muted-foreground p-3 text-center">No matching branches.</p>
    ),
  });

  const branchLabel = state.effectiveBranch ?? "branch";
  // What the *first prompt* will actually do — the checkout/provisioning is
  // deferred until send, so surface that here rather than letting the chip
  // imply the branch already switched.
  const effectHint = firstPromptBranchEffect({ mode, selectedBranch, defaultBranch });

  return (
    <div className={WORKTREE_GROUP}>
      {/* Branch segment — always rendered active: a branch is always selected
          (project default when nothing is picked). */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(WORKTREE_SEGMENT_ACTIVE, "rounded-l-md")}
            title={effectHint ?? undefined}
          >
            <GitBranchIcon className="size-3 shrink-0" />
            <SlidingText text={branchLabel} className="max-w-[160px]" />
            <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[28rem] max-w-[calc(100vw-2rem)] p-0" align="start">
          <div className="flex flex-col">
            <div className="px-2 pt-2 pb-1.5 border-b">
              <Input
                variant="ghost"
                autoFocus
                placeholder="Search branches…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={branchList.onKeyDown}
                className="h-7"
              />
            </div>
            {/* "Use project default" row — clears the explicit pick. */}
            <button
              type="button"
              onClick={() => selectBranch(null)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-left text-sm border-b hover:bg-accent",
                selectedBranch == null && "bg-accent/50",
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium leading-tight">
                  Project default{defaultBranch ? ` (${defaultBranch})` : ""}
                </div>
                <div className="text-xs text-muted-foreground leading-tight">
                  Use the branch the project is currently on.
                </div>
              </div>
              {selectedBranch == null && (
                <CheckIcon className="size-3.5 shrink-0 text-[var(--chip-worktree-fg)]" />
              )}
            </button>
            <BranchList
              isLoading={branchesQuery.isLoading}
              isError={branchesQuery.isError}
              error={branchesQuery.error}
              list={branchList.list}
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* Hairline divider — matches the model-picker group style. */}
      <div className="w-px bg-border" aria-hidden="true" />

      {/* Mode segment. */}
      <WorktreeModePicker
        mode={mode}
        onModeChange={onModeChange}
        state={state}
        effectHint={effectHint}
      />
    </div>
  );
});

interface BranchListProps {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  list: ReactElement;
}

function BranchList({ isLoading, isError, error, list }: BranchListProps): ReactElement {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>Loading branches…</span>
      </div>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-destructive p-3">
        {apiErrorMessage(error, "Failed to load branches.")}
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

function BranchRow({
  branch,
  isActive,
  isDefault,
  isSelected,
  onPick,
}: BranchRowProps): ReactElement {
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
          aria-label="Has worktree"
        />
      ) : (
        <span className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1 truncate font-mono text-xs">{branch.name}</span>
      {isDefault && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">default</span>
      )}
      {!branch.is_local && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">remote</span>
      )}
      {branch.attached_feature_id != null && (
        <span className="text-[10px] text-muted-foreground">
          in use by feature #{branch.attached_feature_id}
        </span>
      )}
      {isSelected && <CheckIcon className="size-3 shrink-0 text-[var(--chip-worktree-fg)]" />}
    </button>
  );
}
