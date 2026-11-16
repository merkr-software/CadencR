import { useCallback, useMemo } from "react";

import type { GitStatusSnapshot, PrStatusSnapshot } from "@/api/generated";
import type { PrSwitcherTab } from "@/components/PrSwitcher";
import { threadPrs, viewedThreadPr, type ThreadPr } from "@/lib/thread-prs";
import { useGitStatusStore } from "@/stores/useGitStatusStore";
import { selectViewedPr, useViewedPrStore } from "@/stores/viewed-pr-store";

export interface ViewedPr {
  /** The proposal the pane shows; `undefined` while the current branch has none. */
  viewed: ThreadPr | undefined;
  /** One per branch with a proposal, the current branch's first; empty when it is alone. */
  tabs: PrSwitcherTab[];
  /** The shown tab's key: a proposal number, `null` for the current branch's. */
  selected: number | null;
  select: (prNumber: number | null) => void;
}

/** The branch the conversation is on, for a tab whose proposal doesn't exist yet. */
function currentBranchName(snapshot: GitStatusSnapshot | undefined): string {
  return (
    snapshot?.thread_branches?.find((branch) => branch.is_current)?.name ??
    snapshot?.current_branch ??
    ""
  );
}

export function useViewedPr(featureId: number, status: PrStatusSnapshot | undefined): ViewedPr {
  const picked = useViewedPrStore(selectViewedPr(featureId));
  const branch = useGitStatusStore((state) => currentBranchName(state.byFeature[featureId]));
  const select = useCallback(
    (prNumber: number | null) => useViewedPrStore.getState().setViewedPr(featureId, prNumber),
    [featureId],
  );
  return useMemo(() => {
    const viewed = viewedThreadPr(status, picked);
    const prs = threadPrs(status);
    const others = prs.filter((entry) => !entry.isCurrent);
    const current = prs.find((entry) => entry.isCurrent);
    const tabs: PrSwitcherTab[] =
      others.length === 0
        ? []
        : [
            { prNumber: null, branch: current?.branch ?? branch, pr: current },
            ...others.map((entry) => ({
              prNumber: entry.pr.number,
              branch: entry.branch,
              pr: entry,
            })),
          ];
    const selected = viewed && !viewed.isCurrent ? viewed.pr.number : null;
    return { viewed, tabs, selected, select };
  }, [branch, picked, select, status]);
}
