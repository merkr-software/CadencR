/**
 * A conversation's proposals across all of its branches.
 *
 * The forge snapshot describes the current branch's proposal at its top level
 * (`pr`, `ci`, `unresolved_threads`, `error`) and the other branches' in
 * `other_prs`. Everything that reasons about "this conversation's pull
 * requests" goes through {@link threadPrs} so the current one is always first
 * and the two shapes never get read differently.
 */
import type { CiRollup, PrStatusSnapshot, PrSummary } from "@/api/generated";

export interface ThreadPr {
  branch: string;
  pr: PrSummary;
  ci?: CiRollup | null;
  unresolved_threads?: number | null;
  /** Only the current proposal carries the forge refresh error. */
  error?: string | null;
  isCurrent: boolean;
}

export function threadPrs(snapshot: PrStatusSnapshot | undefined): ThreadPr[] {
  if (!snapshot) return [];
  const prs: ThreadPr[] = [];
  if (snapshot.pr) {
    prs.push({
      branch: snapshot.pr.source_branch,
      pr: snapshot.pr,
      ci: snapshot.ci,
      unresolved_threads: snapshot.unresolved_threads,
      error: snapshot.error,
      isCurrent: true,
    });
  }
  for (const other of snapshot.other_prs ?? []) {
    prs.push({
      branch: other.branch,
      pr: other.pr,
      ci: other.ci,
      unresolved_threads: other.unresolved_threads,
      isCurrent: false,
    });
  }
  return prs;
}

/** The part of a branch name that tells two of one conversation's apart. */
export function branchTail(branch: string): string {
  return branch.slice(branch.lastIndexOf("/") + 1) || branch;
}

export function isOpenPr(pr: PrSummary): boolean {
  return pr.state === "open" || pr.state === "draft";
}

/** The open proposals besides `shown` — what a "+N" next to it counts. */
export function otherOpenPrs(prs: readonly ThreadPr[], shown: ThreadPr | undefined): ThreadPr[] {
  return prs.filter((entry) => entry.pr.number !== shown?.pr.number && isOpenPr(entry.pr));
}

/**
 * The proposal a branch of this conversation has, if the forge knows one. The
 * current branch's is matched by position rather than name: the forge reports
 * its source branch in its own spelling.
 */
export function prForBranch(
  prs: readonly ThreadPr[],
  branch: { name: string; is_current: boolean },
): ThreadPr | undefined {
  return prs.find((entry) =>
    branch.is_current ? entry.isCurrent : !entry.isCurrent && entry.branch === branch.name,
  );
}

/**
 * The proposal the PR pane shows: the picked one while it is still one of the
 * conversation's, else the current branch's (`undefined` when that branch has
 * none and nothing else was picked).
 */
export function viewedThreadPr(
  snapshot: PrStatusSnapshot | undefined,
  picked: number | undefined,
): ThreadPr | undefined {
  const prs = threadPrs(snapshot);
  return (
    (picked == null ? undefined : prs.find((entry) => entry.pr.number === picked)) ??
    prs.find((entry) => entry.isCurrent)
  );
}

/**
 * `snapshot` re-centred on `entry`, so every view written against the current
 * proposal's snapshot (the status band, its checks) shows another branch's.
 */
export function snapshotForPr(snapshot: PrStatusSnapshot, entry: ThreadPr): PrStatusSnapshot {
  if (entry.isCurrent) return snapshot;
  return {
    ...snapshot,
    pr: entry.pr,
    ci: entry.ci ?? null,
    unresolved_threads: entry.unresolved_threads ?? null,
    error: null,
  };
}
