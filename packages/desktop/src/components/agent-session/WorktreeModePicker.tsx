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
import { useScopedShortcut } from "@/hooks/useShortcut";
import { ResolvedShortcutHint } from "@/components/KbdShortcut";
import { focusInSkillWizard } from "@/components/composer/skill-wizard-focus";
import {
  WORKTREE_MODES,
  describeWorktreeMode,
  isWorktreeModeDisabled,
  nextWorktreeMode,
  type BranchWorktreeState,
  type WorktreeMode,
} from "@/lib/worktree-mode";
import {
  WORKTREE_MANIFEST_SEGMENT,
  WORKTREE_MANIFEST_SEGMENT_ACTIVE,
  WORKTREE_SEGMENT,
  WORKTREE_SEGMENT_ACTIVE,
} from "./meta-bar-chip-styles";
import { SlidingText } from "@/components/SlidingText";

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
  /** Behaviors to list. Defaults to all of them. */
  modes?: readonly WorktreeMode[];
  /** Future-tense summary of what the first prompt will do — surfaced as a
   *  footer so the deferred-until-send behavior is explicit. `null` hides it. */
  effectHint?: string | null;
  /** Bind the cycle shortcut. See `WorktreeChipProps.enableModeShortcut`. */
  enableModeShortcut?: boolean;
  /** `manifest`: an inline token of the composer's launch sentence. */
  variant?: "chip" | "manifest";
}

export const WorktreeModePicker = memo(function WorktreeModePicker({
  mode,
  onModeChange,
  state,
  modes = WORKTREE_MODES,
  effectHint,
  enableModeShortcut = true,
  variant = "chip",
}: WorktreeModePickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const active = modeUsesWorktree(mode);
  const label =
    variant === "manifest"
      ? manifestModeLabel(mode, state)
      : describeWorktreeMode(mode, state).label;
  const handlePick = useCallback(
    (next: WorktreeMode) => {
      onModeChange(next);
      setOpen(false);
    },
    [onModeChange],
  );

  // Cycles the behavior in place — no popover, matching the thinking-effort and
  // permission-mode chips. The trigger's `SlidingText` animates the new label,
  // so the change is still visible from the keyboard.
  useScopedShortcut(
    "agent-worktree-mode",
    () => {
      if (focusInSkillWizard()) return;
      const next = nextWorktreeMode(mode, state, modes);
      if (next) onModeChange(next);
    },
    "agent",
    { enabled: enableModeShortcut, preventDefault: true },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            variant === "manifest"
              ? active
                ? WORKTREE_MANIFEST_SEGMENT_ACTIVE
                : WORKTREE_MANIFEST_SEGMENT
              : cn(active ? WORKTREE_SEGMENT_ACTIVE : WORKTREE_SEGMENT, "rounded-r-md")
          }
          aria-label={
            variant === "manifest"
              ? `Where the agent works: ${label}`
              : "Branch / worktree behavior"
          }
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <SlidingText text={label} className="max-w-[140px]" />
          <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={variant === "manifest" ? "start" : "end"}
        side="top"
        className="w-80 p-1"
      >
        {modes.map((m) => (
          <WorktreeModeRow
            key={m}
            mode={m}
            state={state}
            selected={m === mode}
            onPick={handlePick}
          />
        ))}
        {(effectHint || enableModeShortcut) && (
          <div className="mt-1 flex items-start gap-3 border-t px-2.5 py-2">
            {effectHint && (
              <p className="text-xs text-muted-foreground" role="note">
                {effectHint}
              </p>
            )}
            {enableModeShortcut && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                Cycle
                <ResolvedShortcutHint shortcutId="agent-worktree-mode" />
              </span>
            )}
          </div>
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
        <div className="text-xs leading-tight text-muted-foreground">
          {disabled ? disabledReason(state) : descriptor.description}
        </div>
      </div>
      {selected && <CheckIcon className="size-3.5 shrink-0 text-[var(--chip-worktree-fg)]" />}
    </button>
  );
}

/** Why `branch_worktree` can't apply to this branch (see `isWorktreeModeDisabled`). */
function disabledReason(state: BranchWorktreeState): string {
  const branch = state.effectiveBranch ?? "This branch";
  if (!state.isLocal)
    return `${branch} is a remote branch: start from it in a new worktree instead.`;
  return `${branch} is checked out in the project folder, and git can't check a branch out twice. Start from it in a new worktree instead.`;
}

/** Short noun for the launch sentence: "<label> from|on <branch>". */
function manifestModeLabel(mode: WorktreeMode, state: BranchWorktreeState): string {
  switch (mode) {
    case "on_branch":
      return "Project folder";
    case "branch_worktree":
      return state.hasWorktree ? "Its worktree" : "New worktree";
    case "from_branch":
      return "New branch, project folder";
    case "from_branch_worktree":
      return "New worktree";
  }
}
