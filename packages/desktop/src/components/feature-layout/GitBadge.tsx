import { memo, useState, type ReactElement } from "react";
import { selectGitStatus, useGitStatusStore } from "@/stores/useGitStatusStore";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";

interface GitBadgeProps {
  featureId: number;
  /** Branch fallback while the live snapshot hasn't arrived yet. */
  gitBranch: string | null | undefined;
}

/**
 * Tab-bar badge surfacing the live git state. Three mutually-exclusive
 * states, color-coded so a glance tells you what the next action is:
 *
 *   amber `●N`   — N files modified locally, **commit** them
 *   orange `↑N`  — N commits made, not yet **pushed**
 *   blue `↑N`    — N commits pushed, ahead of target → open **PR / MR**
 *
 * Hover surfaces the full explanation, including the target-branch name
 * (so the blue case clearly says "ahead of `origin/main`", not just "↑N").
 * The tooltip exists because the visual alphabet is short — `↑1` after a
 * push reads ambiguously as "still needs pushing" if you don't know the
 * color code yet, and that ambiguity cost real debugging time during the
 * git-workflow rollout.
 *
 * All counts come from `useGitStatusStore`, populated by the backend
 * watcher via WS. Per `no-optimistic-updates.md`, this badge never
 * computes derived state locally — it just renders what the snapshot
 * says.
 */
export const GitBadge = memo(function GitBadge({
  featureId,
  gitBranch,
}: GitBadgeProps): ReactElement {
  // Narrow selectors so this badge re-renders only when its own feature's
  // counts change (per frontend-performance.md). Other features streaming
  // status updates won't touch this subscription.
  const snapshot = useGitStatusStore(selectGitStatus(featureId));
  const prStatus = usePrStatusStore(selectPrStatus(featureId));
  const branch = snapshot?.current_branch ?? gitBranch ?? null;
  const uncommitted = snapshot?.uncommitted_count ?? 0;
  const aheadOfRemote = snapshot?.ahead_of_remote ?? 0;
  const aheadOfTarget = snapshot?.ahead_of_target ?? 0;
  const targetBranch = snapshot?.target_branch ?? null;

  const indicator = pickIndicator({
    uncommitted,
    aheadOfRemote,
    aheadOfTarget,
    targetBranch,
    hasOpenPr: prStatus?.pr != null,
  });

  return (
    <>
      {branch && (
        <span data-tab-branch className="truncate max-w-[120px]">
          {branch}
        </span>
      )}
      {indicator && (
        <BadgeWithTooltip
          glyph={indicator.glyph}
          count={indicator.count}
          colorClass={indicator.colorClass}
          tooltip={indicator.tooltip}
        />
      )}
    </>
  );
});

export interface IndicatorState {
  /** Single-character prefix — `●` for files, `↑` for commits ahead. */
  glyph: string;
  count: number;
  /** Tailwind color utility — encodes the urgency at a glance. */
  colorClass: string;
  /** Plain-text explanation shown on hover. */
  tooltip: string;
}

/**
 * Three-way priority:
 *   1. Uncommitted files trump everything (you can't push or open a PR
 *      with unstaged work, surface that first).
 *   2. Then "committed but not pushed" (`ahead_of_remote`).
 *   3. Then "pushed but not merged" (`ahead_of_target`) — the steady-
 *      state during code review.
 * Returns `null` when nothing is actionable (clean tree, all merged).
 *
 * Exported for unit tests — every transition has at least one case in
 * `GitBadge.test.tsx` so the state machine doesn't silently drift.
 */
export function pickIndicator(args: {
  uncommitted: number;
  aheadOfRemote: number;
  aheadOfTarget: number;
  targetBranch: string | null;
  hasOpenPr?: boolean;
}): IndicatorState | null {
  const { uncommitted, aheadOfRemote, aheadOfTarget, targetBranch, hasOpenPr = false } = args;

  if (uncommitted > 0) {
    return {
      glyph: "●",
      count: uncommitted,
      colorClass: "text-amber-500",
      tooltip: pluralize(uncommitted, "uncommitted file", "uncommitted files"),
    };
  }
  if (aheadOfRemote > 0) {
    return {
      glyph: "↑",
      count: aheadOfRemote,
      // Orange sits between amber (commit) and blue (PR) — same arrow
      // glyph as the PR-ready state, color is what tells the two apart.
      colorClass: "text-orange-400",
      tooltip: `${pluralize(aheadOfRemote, "commit", "commits")} not pushed yet`,
    };
  }
  if (aheadOfTarget > 0 && !hasOpenPr) {
    return {
      glyph: "↑",
      count: aheadOfTarget,
      colorClass: "text-blue-400",
      tooltip: targetBranch
        ? `${pluralize(aheadOfTarget, "commit", "commits")} pushed, ahead of ${targetBranch} — ready to open a pull request`
        : `${pluralize(aheadOfTarget, "commit", "commits")} pushed, ahead of target`,
    };
  }
  return null;
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

interface BadgeWithTooltipProps {
  glyph: string;
  count: number;
  colorClass: string;
  tooltip: string;
}

/**
 * Tiny hover-popover bound to a single span. Inlined here (rather than
 * pulled from `ShortcutTooltip`) because we don't need the keyboard-shortcut
 * affordance and we want the whole thing to stay one short file. Renders
 * above the trigger so the tab bar (which sits at the top of the feature
 * view) doesn't clip the tooltip.
 */
function BadgeWithTooltip({
  glyph,
  count,
  colorClass,
  tooltip,
}: BadgeWithTooltipProps): ReactElement {
  const [visible, setVisible] = useState(false);
  return (
    <span
      className="relative inline-flex items-center"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span className={colorClass}>
        {glyph}
        {count}
      </span>
      {visible && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg"
        >
          {tooltip}
        </span>
      )}
    </span>
  );
}
