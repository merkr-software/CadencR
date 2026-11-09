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
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, Loader2 } from "lucide-react";

import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useListBranches, type BranchInfo } from "@/api/generated";
import { useBranchList, type BranchListRowContext } from "@/components/branch-chip/BranchList";
import {
  branchWorktreeState,
  createsBranch,
  firstPromptBranchEffect,
  isWorktreeModeDisabled,
  type WorktreeMode,
} from "@/lib/worktree-mode";
import { WorktreeModePicker } from "./WorktreeModePicker";
import {
  WORKTREE_GROUP,
  WORKTREE_MANIFEST_GROUP,
  WORKTREE_MANIFEST_SEGMENT,
  WORKTREE_SEGMENT_ACTIVE,
} from "./meta-bar-chip-styles";
import { SlidingText } from "@/components/SlidingText";

const EMPTY_BRANCHES: BranchInfo[] = [];

const REUSE_FLASH_MS = 420;

/** One-shot pulse when a reusable worktree selection lands after mount. */
function useWorktreeReuseFlash(isReusable: boolean, selectedBranch: string | null): boolean {
  const [reuseFlash, setReuseFlash] = useState(false);
  const skipReuseFlash = useRef(true);
  const reuseFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipReuseFlash.current) {
      skipReuseFlash.current = false;
      return;
    }
    if (!isReusable || selectedBranch == null) {
      setReuseFlash(false);
      return;
    }
    setReuseFlash(true);
    if (reuseFlashTimer.current != null) clearTimeout(reuseFlashTimer.current);
    reuseFlashTimer.current = setTimeout(() => {
      setReuseFlash(false);
      reuseFlashTimer.current = null;
    }, REUSE_FLASH_MS);
    return () => {
      if (reuseFlashTimer.current != null) {
        clearTimeout(reuseFlashTimer.current);
        reuseFlashTimer.current = null;
      }
    };
  }, [isReusable, selectedBranch]);

  return reuseFlash;
}

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
  /** Behaviors to offer. Defaults to all four; the schedule editor drops
   *  "From branch", which its runs can't perform. */
  modes?: readonly WorktreeMode[];
  /** Bind the cycle shortcut. See `WorktreeChipProps.enableModeShortcut`. */
  enableModeShortcut?: boolean;
  /** `manifest`: inline tokens for the composer's launch sentence. */
  variant?: "chip" | "manifest";
}

interface BranchPickerProps {
  variant: "chip" | "manifest";
  open: boolean;
  query: string;
  branchLabel: string;
  effectHint: string | null;
  defaultBranch: string | undefined;
  selectedBranch: string | null;
  branchesQuery: ReturnType<typeof useListBranches>;
  branchList: ReturnType<typeof useBranchList>;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onSelectDefault: () => void;
}

function BranchPicker({
  variant,
  open,
  query,
  branchLabel,
  effectHint,
  defaultBranch,
  selectedBranch,
  branchesQuery,
  branchList,
  onOpenChange,
  onQueryChange,
  onSelectDefault,
}: BranchPickerProps): ReactElement {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            variant === "manifest"
              ? WORKTREE_MANIFEST_SEGMENT
              : cn(WORKTREE_SEGMENT_ACTIVE, "rounded-l-md")
          }
          title={effectHint ?? undefined}
          aria-label={variant === "manifest" ? `Base branch: ${branchLabel}` : undefined}
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
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={branchList.onKeyDown}
              className="h-7"
            />
          </div>
          <button
            type="button"
            onClick={onSelectDefault}
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
  );
}

export const WorktreeButtonGroup = memo(function WorktreeButtonGroup({
  projectId,
  defaultBranch,
  projectPath,
  mode,
  onModeChange,
  selectedBranch,
  onSelectedBranchChange,
  modes,
  enableModeShortcut,
  variant = "chip",
}: WorktreeButtonGroupProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const branchesQuery = useListBranches(
    { project_id: projectId },
    { query: { enabled: open || selectedBranch != null } },
  );
  const branches = branchesQuery.data ?? EMPTY_BRANCHES;
  const state = branchWorktreeState({ selectedBranch, defaultBranch, branches, projectPath });
  const reuseFlash = useWorktreeReuseFlash(
    mode === "branch_worktree" && state.hasWorktree,
    selectedBranch,
  );

  const closePicker = useCallback(() => setOpen(false), []);
  const { selectBranch, handlePick } = useBranchSelection({
    branches,
    defaultBranch,
    projectPath,
    mode,
    onModeChange,
    onSelectedBranchChange,
    close: closePicker,
  });
  const branchList = useBranchPickerList({
    branches,
    query,
    defaultBranch,
    selectedBranch,
    onPick: handlePick,
  });

  const branchLabel = state.effectiveBranch ?? "branch";
  const effectHint = firstPromptBranchEffect({ mode, selectedBranch, defaultBranch });
  // The manifest reads "<mode> from <branch>"; the chip reads "<branch> | <mode>".
  const modePicker = (
    <WorktreeModePicker
      variant={variant}
      mode={mode}
      onModeChange={onModeChange}
      state={state}
      modes={modes}
      effectHint={effectHint}
      enableModeShortcut={enableModeShortcut}
      projectId={projectId}
    />
  );

  return (
    <div
      className={cn(
        variant === "manifest" ? WORKTREE_MANIFEST_GROUP : WORKTREE_GROUP,
        reuseFlash && "worktree-reuse-flash",
      )}
    >
      {variant === "manifest" && modePicker}
      {variant === "manifest" && (
        <span className="px-0.5 text-muted-foreground">{manifestJoiner(mode)}</span>
      )}
      <BranchPicker
        variant={variant}
        open={open}
        query={query}
        branchLabel={branchLabel}
        effectHint={effectHint}
        defaultBranch={defaultBranch}
        selectedBranch={selectedBranch}
        branchesQuery={branchesQuery}
        branchList={branchList}
        onOpenChange={setOpen}
        onQueryChange={setQuery}
        onSelectDefault={() => selectBranch(null)}
      />

      {variant === "chip" && (
        <>
          <div className="w-px bg-border" aria-hidden="true" />
          {modePicker}
        </>
      )}
    </div>
  );
});

/** Picking a branch also moves the mode when the new branch requires it. */
function useBranchSelection({
  branches,
  defaultBranch,
  projectPath,
  mode,
  onModeChange,
  onSelectedBranchChange,
  close,
}: {
  branches: BranchInfo[];
  defaultBranch: string | undefined;
  projectPath: string | undefined;
  mode: WorktreeMode;
  onModeChange: (mode: WorktreeMode) => void;
  onSelectedBranchChange: (next: string | null) => void;
  close: () => void;
}) {
  const selectBranch = useCallback(
    (next: string | null) => {
      onSelectedBranchChange(next);
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
      close();
    },
    [branches, close, defaultBranch, mode, onModeChange, onSelectedBranchChange, projectPath],
  );

  const handlePick = useCallback(
    (branch: BranchInfo) => {
      selectBranch(branch.name === defaultBranch ? null : branch.name);
    },
    [defaultBranch, selectBranch],
  );

  return { selectBranch, handlePick };
}

function useBranchPickerList({
  branches,
  query,
  defaultBranch,
  selectedBranch,
  onPick,
}: {
  branches: BranchInfo[];
  query: string;
  defaultBranch: string | undefined;
  selectedBranch: string | null;
  onPick: (branch: BranchInfo) => void;
}) {
  const renderBranchRow = useCallback(
    (ctx: BranchListRowContext) => (
      <BranchRow
        branch={ctx.branch}
        isActive={ctx.isActive}
        isDefault={defaultBranch === ctx.branch.name}
        isSelected={selectedBranch === ctx.branch.name}
        onPick={onPick}
      />
    ),
    [defaultBranch, onPick, selectedBranch],
  );
  return useBranchList({
    branches,
    query,
    onPick,
    renderRow: renderBranchRow,
    height: 240,
    emptyState: (
      <p className="text-sm text-muted-foreground p-3 text-center">No matching branches.</p>
    ),
  });
}

/** "<mode> from|on <branch>" — the word linking the two manifest tokens. */
function manifestJoiner(mode: WorktreeMode): string {
  return createsBranch(mode) ? "from" : "on";
}

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
