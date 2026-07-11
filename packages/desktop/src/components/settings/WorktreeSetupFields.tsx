import { GitBranch, TerminalSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShellTerminalFrame } from "@/components/ShellTerminalFrame";
import { IconTile } from "./IconTile";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useSyncedSettingInput } from "@/hooks/useSyncedSettingInput";

/** Project setting keys owned by these fields. */
export const WORKTREE_SETUP_KEYS = {
  branchPrefix: "branch_prefix",
  setupWorktree: "setup_worktree",
} as const;

export type WorktreeSetupKey = (typeof WORKTREE_SETUP_KEYS)[keyof typeof WORKTREE_SETUP_KEYS];

/**
 * Branch-prefix + worktree-setup-commands inputs for a project, with the same
 * debounced autosave used everywhere. Shared by the project Settings dialog
 * (Git & Automation section) and the new-project onboarding modal so the two
 * stay in lockstep. Callers own the surrounding card/section chrome.
 */
export function WorktreeSetupFields({
  resetKeyPrefix,
  branchPrefix,
  setupWorktree,
  onSave,
  includeBranchPrefix = true,
}: {
  /** Scopes the local-input reset key (e.g. the project id) so switching
   *  projects re-seeds from the new remote value. */
  resetKeyPrefix: string;
  branchPrefix: string | undefined;
  setupWorktree: string | undefined;
  onSave: (key: WorktreeSetupKey, value: string) => void;
  /** Show the branch-prefix input above the setup commands. Off in the
   *  new-project onboarding modal, which only collects setup commands. */
  includeBranchPrefix?: boolean;
}): React.JSX.Element {
  const branchPrefixInput = useSyncedSettingInput(branchPrefix, `${resetKeyPrefix}:branch_prefix`);
  const setupWorktreeInput = useSyncedSettingInput(
    setupWorktree,
    `${resetKeyPrefix}:setup_worktree`,
  );

  const commitBranchPrefix = useDebouncedCallback((next: string): void => {
    if (next !== (branchPrefix ?? "")) onSave(WORKTREE_SETUP_KEYS.branchPrefix, next);
  }, 400);

  const commitSetupWorktree = useDebouncedCallback((next: string): void => {
    if (next !== (setupWorktree ?? "")) onSave(WORKTREE_SETUP_KEYS.setupWorktree, next);
  }, 600);

  // Scoped so two instances (unlikely, but the component is shared) don't emit
  // a duplicate DOM id / broken label association.
  const branchPrefixId = `branch-prefix-${resetKeyPrefix}`;

  return (
    <>
      {includeBranchPrefix ? (
        <>
          <div className="space-y-2">
            <label htmlFor={branchPrefixId} className="text-sm font-medium">
              Branch prefix
            </label>
            <p className="text-xs text-muted-foreground">Prefix added to worktree branch names.</p>
            <div className="flex items-center gap-2">
              <IconTile tint="cyan">
                <GitBranch className="size-4" />
              </IconTile>
              <Input
                id={branchPrefixId}
                placeholder="e.g. feature/"
                value={branchPrefixInput.value}
                onChange={(e) => {
                  branchPrefixInput.setValue(e.target.value);
                  commitBranchPrefix(e.target.value);
                }}
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="border-t border-border" />
        </>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <IconTile tint="green">
            <TerminalSquare className="size-4" />
          </IconTile>
          <div>
            <div className="text-sm font-medium">Worktree setup commands</div>
            <p className="text-xs text-muted-foreground">
              Shell commands to run after creating a worktree (one per line).
            </p>
          </div>
        </div>
        <ShellTerminalFrame subtitle="one command per line" bodyClassName="p-0">
          <Textarea
            placeholder={"pnpm install\ncp packages/service/.env.example packages/service/.env"}
            rows={4}
            value={setupWorktreeInput.value}
            onChange={(e) => {
              setupWorktreeInput.setValue(e.target.value);
              commitSetupWorktree(e.target.value);
            }}
            className="min-h-24 resize-y rounded-none border-0 bg-[var(--block-bash-body-bg)] font-mono text-xs leading-relaxed text-[var(--block-bash-fg)] placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </ShellTerminalFrame>
      </div>
    </>
  );
}
