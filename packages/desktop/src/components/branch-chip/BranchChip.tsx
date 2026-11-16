/**
 * Header chip naming the branch checked out in the conversation's directory —
 * always the live checkout, even when it is not one of the conversation's
 * branches (then muted, with no pull-request dot). A click opens
 * `ThreadBranchesPanel`: every branch of the conversation, each with its
 * target and pull request — the target used to sit in the chip itself
 * (`current → target`), which spent header width on what is only sometimes
 * needed.
 *
 * - Reads through narrow store selectors, memoized so other features pushing
 *   status updates don't trigger re-renders here.
 * - Click-only. `⌘B` is owned globally by the sidebar toggle; the panel
 *   intentionally has no hotkey so the two don't collide inside a feature
 *   workspace.
 */
import { memo, useState, type ReactElement } from "react";
import { GitBranch } from "lucide-react";

import { prIndicatorTone, PrToneDot } from "@/components/PrStatusIndicators";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { otherOpenPrs, prForBranch, threadPrs, type ThreadPr } from "@/lib/thread-prs";
import { cn } from "@/lib/utils";
import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { checkoutOf, threadBranchesOf, type ThreadCheckout } from "./thread-branches";
import { ThreadBranchesPanel } from "./ThreadBranchesPanel";

interface BranchChipProps {
  featureId: number;
  projectId: number;
}

export const BranchChip = memo(function BranchChip({
  featureId,
  projectId,
}: BranchChipProps): ReactElement | null {
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const prStatus = usePrStatusStore(selectPrStatus(featureId));
  const [open, setOpen] = useState(false);

  const branches = snapshot ? threadBranchesOf(snapshot) : [];
  const checkout = snapshot ? checkoutOf(snapshot, branches) : undefined;
  if (!snapshot || !checkout) {
    // No snapshot yet, or a degraded one (worktree path doesn't exist on
    // disk). Render a placeholder so the chip slot is visible rather than
    // collapsed — "—" is enough to signal "not available right now".
    return (
      <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <GitBranch className="size-3" />
        <span>—</span>
      </div>
    );
  }

  const prs = threadPrs(prStatus);
  const checkoutPr = checkout.branch ? prForBranch(prs, checkout.branch) : undefined;
  const others = branches.filter((branch) => branch.name !== checkout.name).length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-branch-chip
          className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-accent"
          title={chipTitle(checkout)}
          aria-label={`Branch ${checkout.name}, ${branches.length} in this conversation`}
        >
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "max-w-[160px] truncate font-mono",
              !checkout.branch && "text-muted-foreground",
            )}
          >
            {checkout.name}
          </span>
          {checkoutPr && <PrToneDot health={checkoutPr} data-branch-chip-pr />}
          <OtherBranchesCount count={others} prs={prs} shown={checkoutPr} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        align="end"
        onOpenAutoFocus={focusCurrentTarget}
      >
        <ThreadBranchesPanel featureId={featureId} projectId={projectId} snapshot={snapshot} />
      </PopoverContent>
    </Popover>
  );
});

/**
 * Land on the current branch's target, not on the first focusable control:
 * that is the row's unlink button, one stray Enter away from removing it.
 */
function focusCurrentTarget(event: Event): void {
  const content = event.currentTarget;
  if (!(content instanceof HTMLElement)) return;
  const target = content.querySelector<HTMLElement>("[data-thread-branch-target]");
  if (!target) return;
  event.preventDefault();
  target.focus();
}

function chipTitle({ name, branch }: ThreadCheckout): string {
  if (!branch) return `${name} (checked out, not one of this conversation's branches)`;
  return branch.target_branch ? `${name} → ${branch.target_branch}` : name;
}

/**
 * "+N" for the conversation's branches besides the checkout, tinted red when one of their
 * open pull requests fails its checks — the one thing worth surfacing before
 * the panel is opened.
 */
function OtherBranchesCount({
  count,
  prs,
  shown,
}: {
  count: number;
  prs: readonly ThreadPr[];
  /** The checkout's own proposal, already carried by the dot. */
  shown: ThreadPr | undefined;
}): ReactElement | null {
  if (count <= 0) return null;
  const failing = otherOpenPrs(prs, shown).some((entry) => prIndicatorTone(entry) === "danger");
  return (
    <span
      data-branch-chip-others
      className={cn(
        "shrink-0 rounded border px-1 font-mono text-[10px] leading-4 tabular-nums",
        failing
          ? "border-[var(--acc-red)]/40 text-[var(--acc-red)]"
          : "border-border text-muted-foreground",
      )}
    >
      +{count}
    </span>
  );
}
