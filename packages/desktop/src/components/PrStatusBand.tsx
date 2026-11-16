import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useState, type ReactElement, type WheelEvent } from "react";
import type { PrStatusSnapshot } from "@/api/generated";
import { relativeTime } from "@/components/FeaturePrViewParts";
import { ForgeAvatar } from "@/components/ForgeImage";
import { PrApprovalsFact } from "@/components/PrApprovalsFact";
import { PrMergeBar } from "@/components/PrMergeBar";
import { ChecksDisclosure } from "@/components/PrStatusBandChecks";
import { PrToneDot } from "@/components/PrStatusIndicators";
import { Button } from "@/components/ui/button";
import { usePrMergeStatus } from "@/hooks/usePrMergeStatus";
import { openPullRequestExternally } from "@/lib/open-pull-request";
import { isOpenPr } from "@/lib/thread-prs";
import { cn } from "@/lib/utils";

export interface PrStatusBandProps {
  status: PrStatusSnapshot;
  unresolvedCount: number;
  /** True while the unresolved-only filter is the one in force. */
  unresolvedFiltered: boolean;
  onToggleUnresolved: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  /** Forwards a wheel gesture over this unscrollable band to the list below. */
  onWheel?: (event: WheelEvent<HTMLDivElement>) => void;
}

/**
 * Everything that must stay legible while you read the fortieth comment: which
 * proposal this is, and whether anything is blocking it.
 *
 * The old band buried CI inside an accordion that folded itself as you
 * scrolled, so "is it green?" cost a click and an animation. Here the verdict
 * is the row of facts — each one a real control, not a label — and the check
 * list is what opens underneath when you want to know *which* one broke.
 */
export function PrStatusBand({
  status,
  unresolvedCount,
  unresolvedFiltered,
  onToggleUnresolved,
  onRefresh,
  isRefreshing,
  onWheel,
}: PrStatusBandProps): ReactElement {
  const pr = status.pr!;
  const merge = usePrMergeStatus(status);
  const approvals = merge.status?.approvals;
  const showApprovals =
    approvals != null && (approvals.reviewers.length > 0 || (approvals.required ?? 0) > 0);
  // `@container`: the identity block drops its branch line and the check list
  // takes a shorter cap by the width of the band itself. Safe as a containment
  // context here — every overlay under this subtree (tooltips, menus) is
  // portaled out.
  return (
    <div className="@container shrink-0 border-b border-border bg-card/40" onWheel={onWheel}>
      <div className="px-4 pb-2.5 pt-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            {/* Clamped: a long title wrapped to four lines in a narrow pane and
                pushed every review thread off-screen before one was readable. */}
            <h2
              className="line-clamp-2 text-[16px] font-semibold leading-snug tracking-tight text-balance text-foreground"
              title={pr.title}
            >
              {pr.title}
            </h2>
            <PrIdentity status={status} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
            <OpenProposalButton status={status} />
          </div>
        </div>
      </div>
      <ChecksDisclosure
        status={status}
        unresolvedCount={unresolvedCount}
        unresolvedFiltered={unresolvedFiltered}
        onToggleUnresolved={onToggleUnresolved}
        reviewFact={showApprovals ? <PrApprovalsFact approvals={approvals} /> : undefined}
      />
      {isOpenPr(pr) && (
        <PrMergeBar
          // Per proposal: a dialog left open must never reappear on another one.
          key={`${status.feature_id}#${pr.number}`}
          featureId={status.feature_id}
          pr={pr}
          status={merge.status}
          isLoading={merge.isLoading}
          error={merge.errorMessage}
          onRefetch={merge.refetch}
        />
      )}
    </div>
  );
}

/**
 * Number, state, author, freshness on one line; the branch pair on its own.
 *
 * This used to be a single wrapping row with a `·` before each fact, and the
 * branch pair — the longest fact — was the one that wrapped, carrying its dot
 * to the start of the next line ("· feature/…"), which reads as a stray mark
 * rather than punctuation. Two fixed lines and no separator glyphs: spacing
 * (and the avatar between state and author) is what keeps the facts apart, so
 * if the first line does wrap in a narrow pane nothing is stranded. The branch
 * line drops below 24rem — it is the one fact the tab strip and the title
 * already imply — and keeps its full text as a `title` while shown.
 */
function PrIdentity({ status }: { status: PrStatusSnapshot }): ReactElement {
  const pr = status.pr!;
  const author = pr.author.display_name ?? pr.author.username;
  return (
    <div className="space-y-1 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums text-foreground">
          <PrToneDot health={status} />#{pr.number}
        </span>
        <span className="shrink-0 capitalize">{pr.state}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ForgeAvatar user={pr.author} className="size-4 text-[8px]" />
          <span className="max-w-40 truncate">{author}</span>
        </span>
        <span className="shrink-0 tabular-nums">{relativeTime(pr.updated_at)}</span>
      </div>
      <BranchLine source={pr.source_branch} target={pr.target_branch} />
    </div>
  );
}

/** `source → target`, the same glyph and order as the branch chip's title. */
function BranchLine({ source, target }: { source: string; target: string }): ReactElement {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 font-mono @max-[24rem]:hidden"
      title={`${source} → ${target}`}
    >
      <span className="min-w-0 truncate">{source}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground/60">
        →
      </span>
      <span className="sr-only">into</span>
      <span className="max-w-[45%] shrink-0 truncate">{target}</span>
    </div>
  );
}

function RefreshButton({
  onRefresh,
  isRefreshing,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={isRefreshing}
      onClick={onRefresh}
      aria-label="Refresh from the forge"
      title="Refresh from the forge"
    >
      <RefreshCwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} aria-hidden />
    </Button>
  );
}

function OpenProposalButton({ status }: { status: PrStatusSnapshot }): ReactElement {
  const pr = status.pr!;
  const [opening, setOpening] = useState(false);
  const handleOpen = useCallback(async (): Promise<void> => {
    setOpening(true);
    await openPullRequestExternally(pr);
    setOpening(false);
  }, [pr]);
  return (
    <Button variant="outline" size="sm" disabled={opening} onClick={() => void handleOpen()}>
      {opening ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <ExternalLinkIcon className="size-3.5" aria-hidden />
      )}
      Open
    </Button>
  );
}
