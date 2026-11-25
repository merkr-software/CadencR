import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
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

function originLabel(value: BranchOrigin, t: UiTranslator): string {
  switch (value) {
    case "provisioned":
      return t("workspace.git.threadBranchRow.originProvisioned", "original");
    case "checked_out":
      return t("workspace.git.threadBranchRow.originCheckedOut", "checked out here");
    case "agent":
      return t("workspace.git.threadBranchRow.originAgent", "agent");
    case "manual":
      return t("workspace.git.threadBranchRow.originManual", "linked");
    case "head":
      return t("workspace.git.threadBranchRow.originHead", "follows checkout");
  }
}

function originTitle(value: BranchOrigin, t: UiTranslator): string {
  switch (value) {
    case "provisioned":
      return t(
        "workspace.git.threadBranchRow.originHintProvisioned",
        "The branch this conversation was created on",
      );
    case "checked_out":
      return t(
        "workspace.git.threadBranchRow.originHintCheckedOut",
        "Checked out in this conversation's worktree",
      );
    case "agent":
      return t(
        "workspace.git.threadBranchRow.originHintAgent",
        "Checked out by the agent during this conversation",
      );
    case "manual":
      return t("workspace.git.threadBranchRow.originHintManual", "Linked by hand");
    case "head":
      return t(
        "workspace.git.threadBranchRow.originHintHead",
        "This conversation follows whatever the project has checked out",
      );
  }
}

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
  const { t } = useUiTranslation();
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
            {t("workspace.git.threadBranchRow.current", "current")}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[10px] text-muted-foreground"
          title={originTitle(branch.origin, t)}
        >
          {originLabel(branch.origin, t)}
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
          aria-label={t(
            "workspace.git.threadBranchRow.changeTargetOfBranch",
            "Change target of {{branch}}",
            { branch: branch.name },
          )}
          title={t("workspace.git.threadBranchRow.changeTargetBranch", "Change target branch")}
        >
          {branch.target_branch ??
            t("workspace.git.threadBranchRow.defaultTarget", "default target")}
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
  const { t } = useUiTranslation();
  const label = prStatusLabel(pr);
  return (
    <button
      type="button"
      onClick={() => void openPullRequestExternally(pr.pr)}
      className="ml-5 flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={t("workspace.git.threadBranchRow.openLabel", "Open {{label}}", { label: label })}
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
  const { t } = useUiTranslation();
  const { mutate, isPending } = useUnlinkFeatureBranch({
    mutation: {
      onError: (error) =>
        toastError(
          error,
          translateUi(
            "workspace.git.threadBranchRow.failedToUnlinkTheBranch",
            "Failed to unlink the branch.",
          ),
        ),
    },
  });
  if (branch.origin === "provisioned" || branch.origin === "head") return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      aria-label={t("workspace.git.threadBranchRow.unlinkBranch", "Unlink {{branch}}", {
        branch: branch.name,
      })}
      title={t(
        "workspace.git.threadBranchRow.unlinkFromThisConversation",
        "Unlink from this conversation",
      )}
      disabled={isPending}
      onClick={() => mutate({ id: featureId, data: { branch: branch.name } })}
    >
      {isPending ? <Loader2Icon className="size-3 animate-spin" /> : <XIcon className="size-3" />}
    </Button>
  );
}
