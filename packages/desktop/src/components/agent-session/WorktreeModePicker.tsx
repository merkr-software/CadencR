/**
 * Mode segment of the pre-first-prompt worktree chip. Opens a popover listing
 * the explicit branch/worktree behaviors (see `lib/worktree-mode`), each with
 * a one-line description and an adaptive disabled state. Replaces the old
 * boolean "Use worktree" toggle.
 */
import { memo, useCallback, useState, type ReactElement } from "react";
import { CheckIcon, ChevronDownIcon, GitBranchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  WORKTREE_MODES,
  describeWorktreeMode,
  isWorktreeModeDisabled,
  type BranchWorktreeState,
  type WorktreeMode,
} from "@/lib/worktree-mode";
import { WORKTREE_SEGMENT, WORKTREE_SEGMENT_ACTIVE } from "./meta-bar-chip-styles";

/** Modes that actually provision a worktree light the segment cyan, matching
 *  the old "Use worktree" active state. `from_branch` (project path) stays
 *  neutral even though it creates a branch. */
function modeUsesWorktree(mode: WorktreeMode): boolean {
  return mode === "branch_worktree" || mode === "from_branch_worktree";
}

interface WorktreeModePickerProps {
  mode: WorktreeMode;
  onModeChange: (mode: WorktreeMode) => void;
  state: BranchWorktreeState;
  /** Future-tense summary of what the first prompt will do — surfaced as a
   *  footer so the deferred-until-send behavior is explicit. `null` hides it. */
  effectHint?: string | null;
}

export const WorktreeModePicker = memo(function WorktreeModePicker({
  mode,
  onModeChange,
  state,
  effectHint,
}: WorktreeModePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const active = modeUsesWorktree(mode);
  const label = describeWorktreeMode(mode, state).label;
  const handlePick = useCallback(
    (next: WorktreeMode) => {
      onModeChange(next);
      setOpen(false);
    },
    [onModeChange],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(active ? WORKTREE_SEGMENT_ACTIVE : WORKTREE_SEGMENT, "rounded-r-md")}
          aria-label="Branch / worktree behavior"
        >
          <GitBranchIcon className="size-3" />
          <span className="truncate max-w-[140px]">{label}</span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-1">
        {WORKTREE_MODES.map((m) => (
          <WorktreeModeRow
            key={m}
            mode={m}
            state={state}
            selected={m === mode}
            onPick={handlePick}
          />
        ))}
        {effectHint && (
          <p className="mt-1 border-t px-2.5 py-2 text-xs text-muted-foreground" role="note">
            {effectHint}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
});

interface WorktreeModeRowProps {
  mode: WorktreeMode;
  state: BranchWorktreeState;
  selected: boolean;
  onPick: (mode: WorktreeMode) => void;
}

function WorktreeModeRow({ mode, state, selected, onPick }: WorktreeModeRowProps): ReactElement {
  const descriptor = describeWorktreeMode(mode, state);
  const disabled = isWorktreeModeDisabled(mode, state);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(mode)}
      data-state={selected ? "checked" : "unchecked"}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2.5 py-2 text-left",
        disabled ? "cursor-not-allowed opacity-40" : "hover:bg-accent",
        selected && !disabled && "bg-accent/50",
      )}
    >
      {/* Worktree affordance — mirrors the branch picker's "has worktree" icon.
          Shown for modes that create/reuse a worktree; a spacer keeps the
          project-folder rows aligned. */}
      {modeUsesWorktree(mode) ? (
        <GitBranchIcon
          className="mt-0.5 size-3.5 shrink-0 text-[var(--chip-worktree-fg)]"
          aria-label="Uses a worktree"
        />
      ) : (
        <span className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight">{descriptor.label}</div>
        <div className="text-xs leading-tight text-muted-foreground">{descriptor.description}</div>
      </div>
      {selected && <CheckIcon className="size-3.5 shrink-0 text-[var(--chip-worktree-fg)]" />}
    </button>
  );
}
