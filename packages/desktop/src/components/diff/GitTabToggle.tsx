import {
  ArchiveIcon,
  GitBranchIcon,
  GitCommitVerticalIcon,
  GitCompareArrowsIcon,
  GitPullRequestIcon,
  Loader2Icon,
  PencilLineIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { PR_ICON_STYLE, PR_TONE_DOT, type PrIndicatorTone } from "@/components/PrStatusIndicators";
import { useDelayedPending } from "@/hooks/useDelayedPending";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { formatCombo } from "@/lib/shortcuts/format";
import { cn } from "@/lib/utils";
import { useSegmentedThumb } from "./useSegmentedThumb";

export type GitViewMode = "uncommitted" | "vs-target" | "pr" | "graph" | "branches" | "stashes";

/**
 * Below this the strip drops the labels of the views you are *not* in.
 *
 * Sized against the toolbar rather than the window: this pane is routinely a
 * narrow floating column next to the agent stream, and `window.innerWidth` says
 * nothing about that. `rem` rather than `px` on purpose, so the threshold
 * tracks the user's text scale — which also means it is not "480px": at a 120%
 * root size the labels collapse nearer a 600px toolbar, which is the point.
 */
const COMPACT_LABELS = "@max-[30rem]:hidden";

/** Below this, a wait is not a wait — it is a flicker. */
const SPINNER_DELAY_MS = 400;

const SECOND_RANK: {
  mode: GitViewMode;
  icon: LucideIcon;
  label: string;
  hint: string;
  shortcutId: ShortcutId;
}[] = [
  {
    mode: "graph",
    icon: GitCommitVerticalIcon,
    label: "Commits",
    hint: "Commit history graph",
    shortcutId: "git-show-commits",
  },
  {
    mode: "branches",
    icon: GitBranchIcon,
    label: "Branches",
    hint: "Local and remote branches",
    shortcutId: "git-show-branches",
  },
  {
    mode: "stashes",
    icon: ArchiveIcon,
    label: "Stashes",
    hint: "Stashed changes",
    shortcutId: "git-show-stashes",
  },
];

export interface GitTabToggleProps {
  value: GitViewMode;
  onChange: (value: GitViewMode) => void;
  /** Branch shown in the "vs <branch>" label; falls back to "vs target". */
  targetBranch?: string;
  prLabel?: string;
  prNumber?: number;
  /** Colours the proposal's dot, so its health reads from any other sub-view. */
  prTone?: PrIndicatorTone;
  prAttention?: boolean;
  /** Open proposals on the conversation's other branches, and the most urgent one's tone. */
  prOtherCount?: number;
  prOtherTone?: PrIndicatorTone;
  /** Working-tree file count shown on the Changes tab. */
  uncommittedCount?: number;
  conflictCount?: number;
  /**
   * The view whose persistence round trip is still in flight, if any. Pass it
   * raw — the strip decides when a round trip has been slow enough to show.
   */
  pendingValue?: GitViewMode | null;
}

/**
 * The Git tab's sub-navigation.
 *
 * Split into two ranks on purpose. "Changes", the target diff, and the proposal
 * are what a developer moves between all day, so they keep their labels and
 * carry live state — a file count, the proposal's number and health — which
 * makes the strip answer "anything waiting for me?" without opening anything.
 * History, branches, and stashes are occasional, so they collapse to icons:
 * that reclaims roughly a third of the strip, which is what keeps six views
 * fitting a floating pane instead of wrapping.
 */
export const GitTabToggle = memo(function GitTabToggle({
  value,
  onChange,
  targetBranch,
  prLabel = "Pull request",
  prNumber,
  prTone = "neutral",
  prAttention = false,
  prOtherCount = 0,
  prOtherTone = "neutral",
  uncommittedCount,
  conflictCount = 0,
  pendingValue = null,
}: GitTabToggleProps) {
  const targetLabel = useMemo(
    () => (targetBranch && targetBranch.trim() ? `vs ${targetBranch}` : "vs target"),
    [targetBranch],
  );
  // Every label and badge that can change the thumb's target width, in one
  // cheap string — see `useSegmentedThumb`.
  // `prAttention` belongs here even though it only rings a dot: the ring grows
  // the PR tab without changing the strip's own box, so neither the resize
  // observer nor any other field would notice, and the thumb would sit a couple
  // of pixels short until the next tab switch.
  const signature = `${targetLabel}|${prLabel}|${prNumber ?? ""}|${prOtherCount}|${uncommittedCount ?? ""}|${conflictCount}|${prAttention}`;
  const { listRef, thumb } = useSegmentedThumb(value, signature);
  // The spinner takes the tab's icon slot, so a save that lands in a couple of
  // frames — which is every save, against a local database — would swap the
  // glyph out and back before the eye resolves it. That reads as the icon
  // blinking, not as progress.
  const slowPending = useDelayedPending(pendingValue, SPINNER_DELAY_MS);

  return (
    <div
      role="tablist"
      aria-label="Git view mode"
      ref={listRef}
      className="relative flex min-w-0 items-center gap-0.5 rounded-lg border border-border bg-card/70 p-1"
    >
      {thumb && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-1 rounded-md bg-background shadow-xs ring-1 ring-border/70",
            thumb.animate && "transition-[left,width] duration-200 ease-[var(--ease-fluid)]",
          )}
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      <Tab
        mode="uncommitted"
        active={value === "uncommitted"}
        pending={slowPending === "uncommitted"}
        icon={PencilLineIcon}
        label="Changes"
        statusLabel={changesStatusLabel(uncommittedCount, conflictCount)}
        hint="Working-tree changes"
        shortcutId="git-show-uncommitted"
        onChange={onChange}
      >
        <ChangesBadge uncommittedCount={uncommittedCount} conflictCount={conflictCount} />
      </Tab>
      <Tab
        mode="vs-target"
        active={value === "vs-target"}
        pending={slowPending === "vs-target"}
        icon={GitCompareArrowsIcon}
        label={targetLabel}
        labelClassName="max-w-36"
        hint={`Diff against ${targetBranch?.trim() || "the target branch"}`}
        shortcutId="git-show-vs-target"
        onChange={onChange}
      />
      <Tab
        mode="pr"
        active={value === "pr"}
        pending={slowPending === "pr"}
        icon={GitPullRequestIcon}
        label={prNumber == null ? prLabel : `#${prNumber}`}
        // The visible label sheds the noun once there is a number to show, but
        // "#128" on its own is not a name — screen readers get the whole thing.
        name={prNumber == null ? prLabel : `${prLabel} #${prNumber}`}
        hint={`${prLabel} status, checks, and comments`}
        shortcutId="git-show-pull-request"
        onChange={onChange}
      >
        <PrTabSignal tone={prTone} attention={prAttention} hasPr={prNumber != null} />
        <PrOthersBadge count={prOtherCount} tone={prOtherTone} />
      </Tab>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
      {SECOND_RANK.map((tab) => (
        <Tab
          key={tab.mode}
          compact
          mode={tab.mode}
          active={value === tab.mode}
          pending={slowPending === tab.mode}
          icon={tab.icon}
          label={tab.label}
          hint={tab.hint}
          shortcutId={tab.shortcutId}
          onChange={onChange}
        />
      ))}
    </div>
  );
});

interface TabProps {
  mode: GitViewMode;
  active: boolean;
  /**
   * This tab's own save has been in flight long enough to be worth saying so;
   * every other tab stays clickable meanwhile.
   */
  pending: boolean;
  icon: LucideIcon;
  label: string;
  /**
   * Accessible name, when the visible label is not one on its own. Defaults to
   * `label`.
   */
  name?: string;
  /**
   * The live state the badge shows, spelled out. `aria-label` replaces the
   * whole subtree, so without this the conflict and file counts are announced
   * to nobody — the one reader who most needs telling that two paths are
   * unmerged is the one who cannot see the red pill.
   */
  statusLabel?: string;
  /** Tooltip copy — says what the view shows, since the label is often visible. */
  hint: string;
  shortcutId: ShortcutId;
  onChange: (mode: GitViewMode) => void;
  /** Icon-only: the second-rank views, whose label lives in the tooltip. */
  compact?: boolean;
  labelClassName?: string;
  children?: ReactNode;
}

function Tab({
  mode,
  active,
  pending,
  icon: Icon,
  label,
  name,
  statusLabel,
  hint,
  shortcutId,
  onChange,
  compact = false,
  labelClassName,
  children,
}: TabProps): ReactElement {
  const { keys } = useResolvedShortcut(shortcutId);
  const combo = useMemo(() => formatCombo(keys), [keys]);
  return (
    <ShortcutTooltip
      label={compact ? `${label} — ${hint}` : hint}
      keys={combo}
      className={compact ? "shrink-0" : "min-w-0"}
    >
      <button
        type="button"
        role="tab"
        data-active={active}
        aria-selected={active}
        // The label is not always rendered — narrow panes drop it — so the tab
        // carries its own name rather than relying on its contents.
        aria-label={statusLabel ? `${name ?? label}, ${statusLabel}` : (name ?? label)}
        onClick={() => onChange(mode)}
        className={cn(
          "group relative z-10 inline-flex h-6 min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md",
          "text-[12px] font-medium leading-none transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "w-7" : "px-2",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Icon
            className={cn(
              // The icon names a colour in every state, on the button's own
              // curve, and inherits in none of them. Previously only the active
              // state set one: deactivating a tab dropped the icon back to
              // inheriting `currentColor`, which was still `foreground` at that
              // instant, so the icon snapped brighter and only then eased down
              // to muted while its label eased the whole way. That mismatch is
              // what read as a blink. Hover comes off the button rather than
              // the icon so the pair still brightens together.
              "size-3.5 shrink-0 transition-colors duration-150",
              active ? "text-foreground/80" : "text-muted-foreground group-hover:text-foreground",
            )}
            aria-hidden
          />
        )}
        {!compact && (
          <span
            aria-hidden
            className={cn(
              // `truncate` clips to the span's own box, and the button's
              // `leading-none` makes that box exactly one em tall — which is
              // shorter than the glyphs in it, so descenders were sheared off
              // ("Changes" lost the tail of its g). The line box needs the room
              // the font actually asks for; the button stays `h-6` regardless.
              // Unitless rather than `leading-4`: the label's size is a fixed
              // 12px, so a rem-based line box would shrink away from it the
              // moment the root font-size does (the mobile zoom path).
              "truncate leading-[1.35]",
              labelClassName,
              !active && COMPACT_LABELS,
            )}
          >
            {label}
          </span>
        )}
        {!compact && children}
      </button>
    </ShortcutTooltip>
  );
}

/**
 * The Changes tab's count. Conflicts outrank the total: an unmerged path is the
 * one working-tree state that stops everything else, and a developer who sees
 * only "8" walks into it.
 *
 * "Changes", not "files": the backend sums staged + unstaged + untracked, and a
 * partially staged path lands in two of those (`FileStageState::Both`), so the
 * number can exceed the row count of the list it sits above. Conflicts are
 * counted as a set of paths, so that badge really is files.
 */
function changesStatusLabel(
  uncommittedCount: number | undefined,
  conflictCount: number,
): string | undefined {
  if (conflictCount > 0)
    return `${conflictCount} conflicted ${conflictCount === 1 ? "file" : "files"}`;
  if (!uncommittedCount) return undefined;
  return `${uncommittedCount} uncommitted ${uncommittedCount === 1 ? "change" : "changes"}`;
}

function ChangesBadge({
  uncommittedCount,
  conflictCount,
}: {
  uncommittedCount: number | undefined;
  conflictCount: number;
}): ReactElement | null {
  if (conflictCount > 0) {
    return (
      <span
        className="shrink-0 rounded px-1 font-mono text-[10px] leading-[15px] text-[var(--acc-red)] ring-1 ring-[var(--acc-red)]/40 ring-inset"
        title={`${conflictCount} conflicted ${conflictCount === 1 ? "file" : "files"}`}
      >
        {conflictCount}
      </span>
    );
  }
  if (!uncommittedCount) return null;
  return (
    <span
      className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground"
      title={`${uncommittedCount} uncommitted ${uncommittedCount === 1 ? "change" : "changes"}`}
    >
      {uncommittedCount}
    </span>
  );
}

/**
 * The proposal's health, as one dot. Attention (something moved while the user
 * was in another view) rings the dot rather than replacing it — the two answer
 * different questions, and the old orange-dot-only version lost the state to
 * say it about.
 */
function PrTabSignal({
  tone,
  attention,
  hasPr,
}: {
  tone: PrIndicatorTone;
  attention: boolean;
  hasPr: boolean;
}): ReactElement | null {
  if (!hasPr && !attention) return null;
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        hasPr ? PR_TONE_DOT[tone] : "bg-[var(--acc-orange)]",
        attention && "ring-2 ring-[var(--acc-orange)]/45",
      )}
      aria-hidden
    />
  );
}

/** "+N" for the conversation's other open proposals, in the most urgent one's tone. */
function PrOthersBadge({
  count,
  tone,
}: {
  count: number;
  tone: PrIndicatorTone;
}): ReactElement | null {
  if (count <= 0) return null;
  return (
    <span
      data-pr-tab-others
      className={cn("shrink-0 font-mono text-[10px] tabular-nums", PR_ICON_STYLE[tone])}
      title={`${count} more on this conversation's other branches`}
    >
      +{count}
    </span>
  );
}
