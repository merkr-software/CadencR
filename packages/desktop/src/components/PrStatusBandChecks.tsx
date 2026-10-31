import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MessageSquareIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import type { CiCheck, CiState, PrStatusSnapshot, ReviewState } from "@/api/generated";
import { PR_ICON_STYLE, type PrIndicatorTone } from "@/components/PrStatusIndicators";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { openExternalUrl } from "@/lib/open-external";
import { cn } from "@/lib/utils";

/**
 * Amber and yellow as *text*, pulled a fifth of the way toward the foreground.
 * Raw, `--acc-orange` measured 4.49:1 on the light band at 11.5px — just under
 * the bar — and the yellow sits lower still; the mix clears it in light and
 * only brightens them in dark. Rings and icons keep the raw hue
 * (`PR_ICON_STYLE`): they are non-text and their bar is 3:1.
 */
export const TONE_TEXT: Record<PrIndicatorTone, string> = {
  ...PR_ICON_STYLE,
  blocked: "text-[color-mix(in_oklab,var(--acc-orange)_80%,var(--foreground))]",
  unresolved: "text-[color-mix(in_oklab,var(--acc-yellow)_80%,var(--foreground))]",
};

const FACT_RING: Record<PrIndicatorTone, string> = {
  blocked: "ring-[var(--acc-orange)]/30",
  danger: "ring-[var(--acc-red)]/30",
  merged: "ring-[var(--acc-green)]/30",
  neutral: "ring-border",
  ready: "ring-[var(--acc-cyan)]/30",
  unresolved: "ring-[var(--acc-yellow)]/30",
};

function reviewTone(reviewState: ReviewState): PrIndicatorTone {
  if (reviewState === "changes_requested" || reviewState === "pending") return "blocked";
  if (reviewState === "approved") return "ready";
  return "neutral";
}

export function reviewStateLabel(reviewState: ReviewState): string | null {
  if (reviewState === "none") return null;
  if (reviewState === "changes_requested") return "changes requested";
  if (reviewState === "pending") return "review pending";
  return "approved";
}

/**
 * The verdict row, plus the check list it opens.
 *
 * Default-open on a failing run only: that is the one state where the summary
 * ("2 failing") is never the answer you wanted — you came for the name of the
 * job. Everything else stays folded so the band stays a band.
 */
export function ChecksDisclosure({
  status,
  unresolvedCount,
  unresolvedFiltered,
  onToggleUnresolved,
  reviewFact,
}: {
  status: PrStatusSnapshot;
  unresolvedCount: number;
  unresolvedFiltered: boolean;
  onToggleUnresolved: () => void;
  /** Replaces the coarse review-state pill once approvals are known. */
  reviewFact?: ReactNode;
}): ReactElement {
  const ciState = status.ci?.state ?? "none";
  const checks = status.ci?.checks ?? [];
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? ciState === "failing";
  const reviewLabel = reviewFact ? null : reviewStateLabel(status.pr!.review_state);

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
        {checks.length > 0 && (
          <Fact
            tone={ciTone(ciState)}
            icon={<CiStateIcon state={ciState} />}
            expanded={open}
            onClick={() => setOverride(!open)}
          >
            {checkSummary(ciState, checks)}
          </Fact>
        )}
        {unresolvedCount > 0 && (
          <Fact
            tone="unresolved"
            icon={<MessageSquareIcon className="size-3.5 shrink-0" aria-hidden />}
            pressed={unresolvedFiltered}
            onClick={onToggleUnresolved}
          >
            {unresolvedCount} unresolved
          </Fact>
        )}
        {reviewFact}
        {reviewLabel && <Fact tone={reviewTone(status.pr!.review_state)}>{reviewLabel}</Fact>}
        {checks.length === 0 && unresolvedCount === 0 && !reviewLabel && !reviewFact && (
          <span className="text-[11.5px] text-muted-foreground">
            Nothing reported yet — no checks, no reviews, no open threads.
          </span>
        )}
      </div>
      <CollapsibleSection open={open && checks.length > 0}>
        {/*
          The cap has to land mid-row for a long run, and a row sheared flat by
          an invisible edge reads as a rendering fault rather than "scroll for
          more". The mask fades the last few pixels so the cut is legible as a
          cut; `pb-4` is what makes it free when the list fits — the fade then
          lands on empty padding and nothing looks any different.
        */}
        <div
          // Keep native check scrolling out of the band's timeline forwarding.
          onWheel={(event) => event.stopPropagation()}
          className={cn(
            // Shorter cap in a narrow pane: auto-opening a failing run was
            // taking the pinned band to 54% of the pane before one review
            // thread was reachable. Wide, the list is worth the room.
            "max-h-40 @max-[24rem]:max-h-24",
            "overflow-y-auto overscroll-y-contain border-t border-border/70 px-2 pb-4 pt-1.5",
            "[mask-image:linear-gradient(to_bottom,black_calc(100%-1rem),transparent)]",
          )}
        >
          {byUrgency(checks).map((check) => (
            <CiCheckRow key={check.name} check={check} />
          ))}
        </div>
      </CollapsibleSection>
    </>
  );
}

const CHECK_URGENCY: Record<CiState, number> = { failing: 0, running: 1, none: 2, passing: 3 };

/**
 * Broken first, then still-running. The list is capped and scrolls inside a
 * pinned band, so whichever jobs land in the first few rows are the ones most
 * people will ever read — and on a repo with thirty green checks, alphabetical
 * order buries the single red one below the fold.
 */
function byUrgency(checks: readonly CiCheck[]): CiCheck[] {
  return [...checks].sort((left, right) => CHECK_URGENCY[left.state] - CHECK_URGENCY[right.state]);
}

function ciTone(state: CiState): PrIndicatorTone {
  if (state === "failing") return "danger";
  if (state === "passing") return "merged";
  if (state === "running") return "blocked";
  return "neutral";
}

/**
 * What the run actually says. The rollup state is one word for the whole set,
 * so pairing it with the set's size reads as a lie — "6 checks failing" when
 * one job broke. The failing and running counts are the numbers a developer is
 * asking for; the total is context, not the headline.
 */
function checkSummary(state: CiState, checks: readonly CiCheck[]): string {
  const total = checks.length;
  const failing = checks.filter((check) => check.state === "failing").length;
  if (failing > 0) return `${failing} of ${total} failing`;
  const running = checks.filter((check) => check.state === "running").length;
  if (running > 0) return `${running} of ${total} running`;
  if (state === "passing") return `${total} ${total === 1 ? "check" : "checks"} passing`;
  return `${total} ${total === 1 ? "check" : "checks"}`;
}

/** The verdict row's pill: one shape, coloured by tone. */
export function factShellClass(tone: PrIndicatorTone): string {
  return cn(
    "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium leading-none ring-1 ring-inset",
    TONE_TEXT[tone],
    FACT_RING[tone],
  );
}

/**
 * One statement about the proposal. Interactive whenever there is something
 * behind it — the whole point of the row is that the answer to "what is
 * blocking this" is also the way to go look at it.
 *
 * Hover and pressed wash the pill in its own tone (`bg-current`), not
 * `--accent`: in CadencR Dark `--accent` sits one step off `--card`, so an
 * accent-filled "pressed" filter read as no state at all. `leading-none` keeps
 * the text box as tall as its glyphs so `items-center` centres the icons on
 * the words rather than on a taller line box.
 */
function Fact({
  tone,
  icon,
  children,
  onClick,
  expanded,
  pressed,
}: {
  tone: PrIndicatorTone;
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
  pressed?: boolean;
}): ReactElement {
  const shell = factShellClass(tone);
  if (!onClick) {
    return (
      <span className={shell}>
        {icon}
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-pressed={pressed}
      className={cn(
        shell,
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed ? "bg-current/15 ring-current/50" : "hover:bg-current/10",
      )}
    >
      {icon}
      {children}
      {expanded != null && (
        <ChevronDownIcon
          // The chevron's glyph is narrower than its box; pulling it into the
          // padding keeps the pill's right inset matching its left one.
          className={cn(
            "-mr-0.5 size-3 shrink-0 transition-transform duration-150",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      )}
    </button>
  );
}

/**
 * One job: a 28px row (`h-7`) whether or not it links anywhere, so a run that
 * mixes linked and unlinked checks keeps one rhythm. The trailing link icon
 * stays visible and muted rather than hover-revealed — touch layouts force
 * hover reveals on anyway, and a link nobody can see is not an affordance.
 */
function CiCheckRow({ check }: { check: CiCheck }): ReactElement {
  const [opening, setOpening] = useState(false);
  const handleOpen = useCallback(async (): Promise<void> => {
    if (!check.url) return;
    setOpening(true);
    await openExternalUrl(check.url, "Could not open check.");
    setOpening(false);
  }, [check.url]);
  const rowClass = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px]";
  // A settled check recedes: its icon still says green, but its name and word
  // step back so the one failing or running job is what the eye lands on. At
  // equal weight, fifteen green rows outshouted the single red one.
  const settled = check.state === "passing" || check.state === "none";
  const tone = ciTone(check.state);
  const content = (
    <>
      <span className={cn("inline-flex", PR_ICON_STYLE[tone])}>
        <CiStateIcon state={check.state} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          settled ? "text-muted-foreground" : "text-foreground",
        )}
        title={check.name}
      >
        {check.name}
      </span>
      <span
        className={cn(
          "shrink-0 text-[11px] capitalize",
          settled ? "text-muted-foreground" : TONE_TEXT[tone],
        )}
      >
        {check.state}
      </span>
    </>
  );
  if (!check.url) return <div className={rowClass}>{content}</div>;
  return (
    <button
      type="button"
      className={cn(rowClass, "transition-colors hover:bg-accent/60 disabled:opacity-60")}
      disabled={opening}
      onClick={() => void handleOpen()}
    >
      {content}
      {opening ? (
        <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

/**
 * `Loader2` draws its arc at r=9 where the circle icons draw r=10, so at one
 * size the spinner read a notch smaller than its neighbours; `scale-110` (the
 * standalone `scale` property, which composes with the spin's `transform`)
 * brings it to the same optical size.
 */
function CiStateIcon({ state }: { state: CiState }): ReactElement {
  if (state === "passing") return <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden />;
  if (state === "failing") return <XCircleIcon className="size-3.5 shrink-0" aria-hidden />;
  if (state === "running")
    return <Loader2Icon className="size-3.5 shrink-0 scale-110 animate-spin" aria-hidden />;
  return <CircleDashedIcon className="size-3.5 shrink-0" aria-hidden />;
}
