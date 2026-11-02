import { useCallback, useMemo, type ReactElement } from "react";
import { GitBranchIcon, Loader2Icon } from "lucide-react";
import { useListFeatureWorktrees, type FeatureWorktreeInfo } from "@/api/generated";
import { cn } from "@/lib/utils";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { apiErrorMessage } from "@/lib/api-errors";
import type { ReferencedWorktreeSelection } from "./agent-prompt-bar-types";
import {
  parseConversationReferences,
  type ParsedConversationReference,
} from "./prompt-editor/conversation-reference";
import { ResolvedShortcutHint } from "./KbdShortcut";
import { STACK_ROW_BUTTON_CLASS, StackSection } from "./composer/ComposerStack";

interface ReferencedWorktreeTipProps {
  prompt: string;
  projectId: number;
  selection: ReferencedWorktreeSelection;
  agentTabActive: boolean;
  shortcutsDisabled: boolean;
}

interface ReferencedWorktree {
  branch: string;
  label: string;
  path: string;
}

function findReferencedWorktree(
  references: ParsedConversationReference[],
  worktrees: FeatureWorktreeInfo[] | undefined,
): ReferencedWorktree | null {
  if (!worktrees) return null;
  for (const reference of references) {
    const worktree = worktrees.find(
      (candidate) =>
        candidate.feature_id === reference.featureId &&
        candidate.live &&
        !candidate.is_main_worktree &&
        candidate.worktree_branch != null,
    );
    if (worktree?.worktree_branch) {
      return {
        branch: worktree.worktree_branch,
        label: reference.label,
        path: worktree.worktree_path,
      };
    }
  }
  return null;
}

export function ReferencedWorktreeTip({
  prompt,
  projectId,
  selection,
  agentTabActive,
  shortcutsDisabled,
}: ReferencedWorktreeTipProps): ReactElement | null {
  const references = useMemo(() => parseConversationReferences(prompt), [prompt]);
  const enabled = references.length > 0;
  const worktreesQuery = useListFeatureWorktrees({ project_id: projectId }, { query: { enabled } });
  const worktree = useMemo(
    () => findReferencedWorktree(references, worktreesQuery.data),
    [references, worktreesQuery.data],
  );
  const alreadySelected =
    worktree != null &&
    selection.mode === "branch_worktree" &&
    selection.selectedBranch === worktree.branch;
  const useWorktree = useCallback((): void => {
    if (worktree) selection.onSelect(worktree.branch);
  }, [selection, worktree]);
  const shortcutOptions = useMemo(
    () => ({
      enabled:
        enabled && worktree != null && agentTabActive && !shortcutsDisabled && !alreadySelected,
      preventDefault: true,
    }),
    [agentTabActive, alreadySelected, enabled, shortcutsDisabled, worktree],
  );

  useScopedShortcut(
    "agent-use-referenced-worktree",
    (event) => {
      if (!worktree || alreadySelected) return;
      event.preventDefault();
      useWorktree();
    },
    "agent",
    shortcutOptions,
  );

  if (!enabled || alreadySelected) return null;
  if (worktreesQuery.isLoading) {
    return (
      <StackSection
        tone="worktree"
        label="Referenced worktree"
        role="status"
        icon={<Loader2Icon className="animate-spin" />}
        title="Worktree"
        hint="Checking the referenced conversation for a worktree…"
      />
    );
  }
  if (worktreesQuery.isError) {
    return (
      <StackSection tone="worktree" label="Referenced worktree" role="status">
        <p className="px-1.5 text-[11px] text-destructive">
          {apiErrorMessage(worktreesQuery.error, "Could not check the referenced worktree.")}
        </p>
      </StackSection>
    );
  }
  if (!worktree) return null;

  const ariaLabel = `Reuse ${worktree.branch} worktree from ${worktree.label} when you send`;

  return (
    <StackSection
      tone="worktree"
      label="Referenced worktree"
      icon={<GitBranchIcon />}
      title="Worktree"
      hint="Referenced conversation"
      summary={`Reuse ${worktree.branch} from ${worktree.label} when you send`}
    >
      <button
        type="button"
        onClick={useWorktree}
        title={`Reuse ${worktree.path} when you send your first message`}
        aria-label={ariaLabel}
        className={cn(STACK_ROW_BUTTON_CLASS, "text-xs")}
      >
        <span className="min-w-0 flex-1 truncate">
          Reuse <span className="font-mono">{worktree.branch}</span> from {worktree.label} when you
          send
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          Reuse worktree
          <ResolvedShortcutHint shortcutId="agent-use-referenced-worktree" />
        </span>
      </button>
    </StackSection>
  );
}
