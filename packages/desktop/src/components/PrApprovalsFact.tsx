import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { CheckIcon, CircleDashedIcon, MessageSquareIcon, XIcon } from "lucide-react";
import type { ReactElement } from "react";
import type { PrApprovals, PrReviewer, ReviewerDecision } from "@/api/generated";
import { ForgeAvatar } from "@/components/ForgeImage";
import { PR_ICON_STYLE, type PrIndicatorTone } from "@/components/PrStatusIndicators";
import { factShellClass, TONE_TEXT } from "@/components/PrStatusBandChecks";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { approvalsSummary, approvalsTone } from "@/lib/pr-merge";
import { cn } from "@/lib/utils";

/** Faces shown in the pill before the rest fold into the popover. */
const MAX_STACKED_AVATARS = 3;

function decisionLabel(value: ReviewerDecision, t: UiTranslator): string {
  switch (value) {
    case "approved":
      return t("workspace.git.prApprovalsFact.reviewApproved", "Approved");
    case "changes_requested":
      return t("workspace.git.prApprovalsFact.reviewChangesRequested", "Changes requested");
    case "commented":
      return t("workspace.git.prApprovalsFact.reviewCommented", "Commented");
    case "pending":
      return t("workspace.git.prApprovalsFact.reviewPending", "Review requested");
  }
}

const DECISION_TONE: Record<ReviewerDecision, PrIndicatorTone> = {
  approved: "ready",
  changes_requested: "blocked",
  commented: "neutral",
  pending: "neutral",
};

/**
 * "1 of 2 approvals" with the approvers' faces, in the verdict row. The count
 * is the answer most of the time; the popover is there for "who still has to
 * look at this?".
 */
export function PrApprovalsFact({ approvals }: { approvals: PrApprovals }): ReactElement {
  const { t } = useUiTranslation();
  const tone = approvalsTone(approvals);
  const approvers = approvals.reviewers.filter((reviewer) => reviewer.decision === "approved");
  const changesRequested = approvals.reviewers.filter(
    (reviewer) => reviewer.decision === "changes_requested",
  ).length;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            factShellClass(tone),
            "transition-colors hover:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {approvers.length > 0 ? (
            <span className="-ml-0.5 flex -space-x-1">
              {approvers.slice(0, MAX_STACKED_AVATARS).map((reviewer) => (
                <ForgeAvatar
                  key={reviewer.user.username}
                  user={reviewer.user}
                  className="size-4 text-[7px] ring-1 ring-card"
                />
              ))}
            </span>
          ) : (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          {approvalsSummary(approvals, t)}
          {changesRequested > 0 && (
            <span className="text-[11px]">
              {t("workspace.git.prApprovalsFact.changesRequested", "· changes requested")}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <ReviewerList approvals={approvals} />
      </PopoverContent>
    </Popover>
  );
}

function ReviewerList({ approvals }: { approvals: PrApprovals }): ReactElement {
  const { t } = useUiTranslation();
  if (approvals.reviewers.length === 0) {
    return (
      <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
        {t("workspace.git.prApprovalsFact.noReviewersYet", "No reviewers yet.")}
      </p>
    );
  }
  return (
    <ul
      className="max-h-64 overflow-y-auto"
      aria-label={t("workspace.git.prApprovalsFact.reviewers", "Reviewers")}
    >
      {approvals.reviewers.map((reviewer) => (
        <ReviewerRow key={reviewer.user.username} reviewer={reviewer} />
      ))}
      {approvals.required != null && approvals.required > 0 && (
        <li className="mt-1 border-t border-border/70 px-2 pb-0.5 pt-1.5 text-[11px] text-muted-foreground">
          {t(
            "workspace.git.prApprovalsFact.requiredApprovals",
            "The target branch requires {{count, number}} approvals.",
            {
              count: approvals.required,
              defaultValue_one: "The target branch requires {{count, number}} approval.",
            },
          )}
        </li>
      )}
    </ul>
  );
}

function ReviewerRow({ reviewer }: { reviewer: PrReviewer }): ReactElement {
  const { t } = useUiTranslation();
  const name = reviewer.user.display_name ?? reviewer.user.username;
  const tone = DECISION_TONE[reviewer.decision];
  return (
    <li className="flex h-8 items-center gap-2 rounded-md px-2 text-[12px]">
      <ForgeAvatar user={reviewer.user} className="size-5 text-[8px]" />
      <span className="min-w-0 flex-1 truncate text-foreground" title={reviewer.user.username}>
        {name}
      </span>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 text-[11px]",
          reviewer.decision === "approved" || reviewer.decision === "changes_requested"
            ? TONE_TEXT[tone]
            : "text-muted-foreground",
        )}
      >
        <span className={cn("inline-flex", PR_ICON_STYLE[tone])}>
          <DecisionIcon decision={reviewer.decision} />
        </span>
        {decisionLabel(reviewer.decision, t)}
      </span>
    </li>
  );
}

function DecisionIcon({ decision }: { decision: ReviewerDecision }): ReactElement {
  if (decision === "approved") return <CheckIcon className="size-3" aria-hidden />;
  if (decision === "changes_requested") return <XIcon className="size-3" aria-hidden />;
  if (decision === "commented") return <MessageSquareIcon className="size-3" aria-hidden />;
  return <CircleDashedIcon className="size-3" aria-hidden />;
}
