/**
 * Keyboard-first Git action picker for `GitActionButton`.
 */
import { type ComponentType, type ReactElement } from "react";
import { GitCommit, GitMerge, GitPullRequest, Upload } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { CommitActivity, GitAction, GitActionState } from "./useGitAction";

export const ICONS: Record<GitAction, ComponentType<{ className?: string }>> = {
  commit: GitCommit,
  push: Upload,
  pr: GitPullRequest,
  merge: GitMerge,
};

const ACTION_LABELS: Record<GitAction, string> = {
  commit: "Commit",
  push: "Push",
  pr: "Open compare",
  merge: "Merge",
};

const ACTIONS: readonly GitAction[] = ["commit", "push", "pr", "merge"] as const;

interface GitActionPopoverProps {
  state: GitActionState;
  commitActivity?: CommitActivity;
  onPick: (action: GitAction) => void;
}

export function GitActionPopover({
  state,
  commitActivity = null,
  onPick,
}: GitActionPopoverProps): ReactElement {
  return (
    <Command>
      <CommandInput autoFocus placeholder="Search git actions…" />
      <CommandList>
        <CommandEmpty>No matching git action.</CommandEmpty>
        <CommandGroup>
          {ACTIONS.map((action) => {
            const Icon = ICONS[action];
            const reason = action === "commit" && commitActivity ? null : state.disabled[action];
            const label =
              action === "commit" && commitActivity === "running"
                ? "View commit progress"
                : action === "commit" && commitActivity === "failed"
                  ? "View commit error"
                  : action === "pr"
                    ? state.compareLabel
                    : ACTION_LABELS[action];
            return (
              <CommandItem
                key={action}
                value={`${label} ${action}`}
                disabled={reason !== null}
                onSelect={() => onPick(action)}
                title={reason ?? label}
                className="justify-between"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
                {reason && (
                  <span className="ml-3 max-w-[170px] truncate text-[10px] text-muted-foreground">
                    {reason}
                  </span>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
