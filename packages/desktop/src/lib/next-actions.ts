import type { CiRollup, Feature, PrStatusSnapshot, PrSummary } from "@/api/generated";
import { prIndicatorTone } from "@/components/PrStatusIndicators";
import { isOpenPr, threadPrs, type ThreadPr } from "@/lib/thread-prs";
import type { AttentionEntry } from "@/lib/attention-index";
import type { SidebarConfig } from "@/lib/sidebar-config";

/**
 * What the user should do next about a conversation, most urgent first:
 * - waiting: answer the agent's pending request (it stays stopped until then);
 * - failed: look at the error that stopped the turn;
 * - fix_ci / address_review: the pull request is blocked on its checks or its review;
 * - review: the agent finished, nobody has read the result yet;
 * - merge: the pull request is approved and its checks are green.
 */
export type NextActionKind =
  | "waiting"
  | "failed"
  | "fix_ci"
  | "address_review"
  | "review"
  | "merge";

export interface NextActionEntry {
  featureId: number;
  kind: NextActionKind;
}

export interface ResolvedNextAction {
  feature: Feature;
  kind: NextActionKind;
}

/** Tiers in the order the "For me" block lists them; within a tier, oldest first. */
const TIER: Record<NextActionKind, number> = {
  waiting: 0,
  failed: 1,
  fix_ci: 2,
  address_review: 2,
  review: 3,
  merge: 4,
};

/**
 * What a pull request asks of the user, if anything. "Merge" takes the row's
 * PR chip verdict (`prIndicatorTone`), so the two never disagree: no merge
 * while threads are unresolved or checks still run. A snapshot the forge
 * failed to refresh asks nothing: its state may be stale.
 */
function entryActionKind(entry: ThreadPr): NextActionKind | null {
  const { pr } = entry;
  if (entry.error || !isOpenPr(pr)) return null;
  if (entry.ci?.state === "failing") return "fix_ci";
  if (pr.review_state === "changes_requested") return "address_review";
  if (pr.review_state === "approved" && prIndicatorTone(entry) === "ready") return "merge";
  return null;
}

export interface PrAction {
  kind: NextActionKind;
  pr: PrSummary;
  ci?: CiRollup | null;
}

/**
 * The most urgent thing any of the conversation's pull requests asks for —
 * the current branch's wins a tie, the others are not left out: a stacked
 * branch's failing checks are as much the user's job.
 */
export function prAction(snapshot: PrStatusSnapshot | undefined): PrAction | null {
  let best: PrAction | null = null;
  for (const entry of threadPrs(snapshot)) {
    const kind = entryActionKind(entry);
    if (kind && (!best || TIER[kind] < TIER[best.kind])) {
      best = { kind, pr: entry.pr, ci: entry.ci };
    }
  }
  return best;
}

export function prActionKind(snapshot: PrStatusSnapshot | undefined): NextActionKind | null {
  return prAction(snapshot)?.kind ?? null;
}

function actionKey(kind: NextActionKind, pr: { number: number; head_sha: string }): string {
  return `${kind}:${pr.number}:${pr.head_sha}`;
}

/**
 * Names a pull request action as of the pull request's head commit, so a
 * dismissed "Fix CI" or "Merge" stays dismissed until a push, or until the
 * pull request asks for something else (a review verdict turning it from
 * "Address review" to "Merge").
 */
export function prActionKey(snapshot: PrStatusSnapshot | undefined): string | null {
  const action = prAction(snapshot);
  return action ? actionKey(action.kind, action.pr) : null;
}

/**
 * The "For me" action list: one action per conversation, its most urgent one.
 * `attention` is the attention index (already oldest first within a state);
 * pull request actions are ordered by when the pull request last moved. A
 * conversation whose agent is at work is left out: nothing to do there yet,
 * and so is a pull request action the user marked done (`prAcks`, keyed by
 * conversation, holding the {@link prActionKey} they dismissed).
 */
export function deriveNextActions(
  attention: readonly AttentionEntry[],
  prByFeature: Readonly<Record<number, PrStatusSnapshot>>,
  prAcks: Readonly<Record<number, string>> = {},
): NextActionEntry[] {
  const best = new Map<number, { kind: NextActionKind; order: number }>();
  const working = new Set<number>();
  attention.forEach((entry, index) => {
    if (entry.state === "working") {
      working.add(entry.featureId);
      return;
    }
    // An unread conversation is a finished turn: what it asks for is a review.
    const kind = entry.state === "unread" ? "review" : entry.state;
    best.set(entry.featureId, { kind, order: index });
  });

  const prEntries = Object.values(prByFeature)
    .filter((snapshot) => !working.has(snapshot.feature_id))
    .map((snapshot) => ({ featureId: snapshot.feature_id, action: prAction(snapshot) }))
    .filter(
      (item): item is { featureId: number; action: PrAction } =>
        item.action != null &&
        prAcks[item.featureId] !== actionKey(item.action.kind, item.action.pr),
    )
    .sort(
      (a, b) =>
        a.action.pr.updated_at.localeCompare(b.action.pr.updated_at) || a.featureId - b.featureId,
    );
  prEntries.forEach(({ featureId, action }, index) => {
    const current = best.get(featureId);
    if (!current || TIER[action.kind] < TIER[current.kind]) {
      best.set(featureId, { kind: action.kind, order: attention.length + index });
    }
  });

  return [...best.entries()]
    .sort(([, a], [, b]) => TIER[a.kind] - TIER[b.kind] || a.order - b.order)
    .map(([featureId, { kind }]) => ({ featureId, kind }));
}

/**
 * How many of For me's `total` actions show: the "For me shows" limit (3, 5 or
 * all), or every one once "Show more" is on.
 */
export function forMeVisibleCount(
  total: number,
  limit: SidebarConfig["forMeLimit"],
  showAll: boolean,
): number {
  return showAll || limit === "all" ? total : Math.min(total, Number(limit));
}

/** A pending request or a failed turn: what turns the block's counter amber. */
export function isStrongAction({ kind }: { kind: NextActionKind }): boolean {
  return kind === "waiting" || kind === "failed";
}
