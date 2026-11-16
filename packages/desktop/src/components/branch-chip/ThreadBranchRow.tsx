/**
 * One branch of a conversation in the header's branch panel: its name and how
 * it came to belong here, its compare target (click to change), and its pull
 * request when the forge knows one.
 */
import type { ReactElement } from "react";
import {
  ArrowRightIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";

import { useUnlinkFeatureBranch, type BranchOrigin, type ThreadBranch } from "@/api/generated";
import { prStatusLabel, PrToneDot } from "@/components/PrStatusIndicators";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/api-errors";
import { openPullRequestExternally } from "@/lib/open-pull-request";
import type { ThreadPr } from "@/lib/thread-prs";
import { cn } from "@/lib/utils";

const ORIGIN_LABEL: Record<BranchOrigin, string> = {
  provisioned: "original",
  checked_out: "checked out here",
  agent: "agent",
  manual: "linked",
  head: "follows checkout",
};

const ORIGIN_TITLE: Record<BranchOrigin, string> = {
  provisioned: "The branch this conversation was created on",
  checked_out: "Checked out in this conversation's worktree",
  agent: "Checked out by the agent during this conversation",
  manual: "Linked by hand",
  head: "This conversation follows whatever the project has checked out",
};

interface ThreadBranchRowProps {
  featureId: number;
  branch: ThreadBranch;
  pr: ThreadPr | undefined;
  /** Commits ahead of / behind the target, known for the current branch only. */
  divergence?: { ahead: number; behind: number };
  onEditTarget: (branch: ThreadBranch) => void;
}

export function ThreadBranchRow({
  featureId,
  branch,
  pr,
  divergence,
  onEditTarget,
}: ThreadBranchRowProps): ReactElement {
  return (
    <li
      data-thread-branch={branch.name}
      className={cn("group/row flex flex-col gap-1 px-3 py-2", branch.is_current && "bg-accent/30")}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranchIcon
          className={cn(
            "size-3.5 shrink-0",
            branch.is_current ? "text-[var(--acc-cyan)]" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="min-w-0 truncate font-mono text-xs" title={branch.name}>
          {branch.name}
        </span>
        {branch.is_current && (
          <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
            current
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[10px] text-muted-foreground"
          title={ORIGIN_TITLE[branch.origin]}
        >
          {ORIGIN_LABEL[branch.origin]}
        </span>
        <UnlinkButton featureId={featureId} branch={branch} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-5 text-[11px] text-muted-foreground">
        <ArrowRightIcon className="size-3 shrink-0" aria-hidden />
        <button
          type="button"
          data-thread-branch-target
          onClick={() => onEditTarget(branch)}
          className="min-w-0 truncate rounded px-1 py-0.5 font-mono hover:bg-accent hover:text-foreground"
          aria-label={`Change target of ${branch.name}`}
          title="Change target branch"
        >
          {branch.target_branch ?? "default target"}
        </button>
        {divergence && (
          <span className="shrink-0 font-mono tabular-nums">
            ↑{divergence.ahead} ↓{divergence.behind}
          </span>
        )}
      </div>
      {pr && <BranchPrLine pr={pr} />}
    </li>
  );
}

function BranchPrLine({ pr }: { pr: ThreadPr }): ReactElement {
  const label = prStatusLabel(pr);
  return (
    <button
      type="button"
      onClick={() => void openPullRequestExternally(pr.pr)}
      className="ml-5 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={`Open ${label}`}
      title={pr.pr.title}
    >
      <PrToneDot health={pr} />
      <GitPullRequestIcon className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/**
 * Remove a branch from the conversation. The original branch is the
 * conversation's identity and a followed checkout is not stored, so neither
 * can be unlinked.
 */
function UnlinkButton({
  featureId,
  branch,
}: {
  featureId: number;
  branch: ThreadBranch;
}): ReactElement | null {
  const { mutate, isPending } = useUnlinkFeatureBranch({
    mutation: { onError: (error) => toastError(error, "Failed to unlink the branch.") },
  });
  if (branch.origin === "provisioned" || branch.origin === "head") return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      aria-label={`Unlink ${branch.name}`}
      title="Unlink from this conversation"
      disabled={isPending}
      onClick={() => mutate({ id: featureId, data: { branch: branch.name } })}
    >
      {isPending ? <Loader2Icon className="size-3 animate-spin" /> : <XIcon className="size-3" />}
    </Button>
  );
}
