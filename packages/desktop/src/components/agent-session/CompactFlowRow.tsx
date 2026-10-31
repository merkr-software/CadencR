import { memo, useCallback, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { AgentBlockData } from "@/components/AgentBlock";
import { hasCompactLine } from "@/components/agentStreamDisplay";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { cn } from "@/lib/utils";
import { animationsDisabled } from "@/lib/animations/animations-disabled";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { CompactToolLine } from "./CompactToolLine";

/** Steps the unfolded list mounts before asking: a long autonomous run can hold hundreds. */
const STEP_PAGE = 100;

interface CompactFlowRowProps {
  blocks: AgentBlockData[];
  basePath?: string;
  /** A block of this run the conversation search is on: unfold to show it. */
  revealBlockId?: string;
}

function sameCompactFlowRow(previous: CompactFlowRowProps, next: CompactFlowRowProps): boolean {
  if (
    previous.basePath !== next.basePath ||
    previous.revealBlockId !== next.revealBlockId ||
    previous.blocks.length !== next.blocks.length
  ) {
    return false;
  }
  return previous.blocks.every((block, index) => block === next.blocks[index]);
}

/**
 * One run of consecutive non-text blocks in the "Compact flow" verbosity mode,
 * folded to a single line: the most recent step, with a count of the earlier
 * ones. A click unfolds every step, newest first, one line each, so the
 * transcript reads as prompts and answers with the work in between kept to a
 * line. `buildDisplayItems` yields one row per run.
 */
export const CompactFlowRow = memo(function CompactFlowRow({
  blocks,
  basePath,
  revealBlockId,
}: CompactFlowRowProps) {
  const newestFirst = useMemo(() => blocks.filter(hasCompactLine).reverse(), [blocks]);
  const [newest, ...older] = newestFirst;
  const revealIndex = revealBlockId ? older.findIndex((block) => block.id === revealBlockId) : -1;
  const [expanded, setExpanded] = useRevealableExpansion(
    revealIndex >= 0 ? (revealBlockId ?? null) : null,
  );
  const toggle = useCallback(() => {
    // Keep the clicked row in place while the list animates open below it.
    suppressAutoScrollPin();
    setExpanded((value) => !value);
  }, [setExpanded]);
  const { handOver, endHandOver } = useHeadHandOver(newest?.id);
  if (!newest) return null;
  const head = (
    <CompactFlowHead
      newest={newest}
      entering={handOver?.enteringId === newest.id}
      leaving={handOver ? older.find((block) => block.id === handOver.leavingId) : undefined}
      onHandedOver={endHandOver}
      basePath={basePath}
    />
  );
  // `-mx-1` cancels the line's own padding: icons sit on the prose's left
  // edge while the hover wash still breathes around the content.
  return (
    <div className="-mx-1 my-1 text-xs">
      {older.length === 0 ? (
        <div className={HEAD_CLASS}>{head}</div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className={cn(
            HEAD_CLASS,
            "group/flow rounded-sm transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          {head}
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/60 tabular-nums transition-colors group-hover/flow:text-muted-foreground">
            +{older.length}
            <span className="sr-only">
              {older.length === 1 ? " earlier step" : " earlier steps"}
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 transition-transform duration-200 ease-[var(--ease-fluid)]",
                expanded && "rotate-90",
              )}
            />
          </span>
        </button>
      )}
      {older.length > 0 && (
        // The list is its own component so a folded row builds none of it.
        <CollapsibleSection open={expanded}>
          <CompactFlowSteps steps={older} basePath={basePath} revealIndex={revealIndex} />
        </CollapsibleSection>
      )}
    </div>
  );
}, sameCompactFlowRow);

/** Fold state that also opens when the conversation search lands on a folded step. */
function useRevealableExpansion(revealBlockId: string | null) {
  const [expanded, setExpanded] = useState(revealBlockId !== null);
  const [revealed, setRevealed] = useState(revealBlockId);
  if (revealed !== revealBlockId) {
    setRevealed(revealBlockId);
    if (revealBlockId !== null) setExpanded(true);
  }
  return [expanded, setExpanded] as const;
}

interface CompactFlowStepsProps {
  steps: AgentBlockData[];
  basePath?: string;
  /** Index of the step the search is on; it is always within the mounted page. */
  revealIndex: number;
}

function CompactFlowSteps({ steps, basePath, revealIndex }: CompactFlowStepsProps) {
  const [limit, setLimit] = useState(STEP_PAGE);
  const shown = Math.max(limit, revealIndex + 1);
  const hidden = steps.length - shown;
  return (
    // The rule runs under the head icon; steps hang on the head's label column.
    <ol className="ml-2.5 border-l border-border/60 pl-[11px]">
      {steps.slice(0, shown).map((block) => (
        <li key={block.id} data-block-id={block.id} className="flex h-6 min-w-0 items-center">
          <CompactToolLine block={block} basePath={basePath} />
        </li>
      ))}
      {hidden > 0 && (
        <li className="flex h-6 items-center">
          <button
            type="button"
            onClick={() => {
              suppressAutoScrollPin();
              setLimit(steps.length);
            }}
            className="rounded-sm px-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            Show {hidden} older {hidden === 1 ? "step" : "steps"}
          </button>
        </li>
      )}
    </ol>
  );
}

interface CompactLatestStepProps {
  /** Steps in order; blocks without a compact line are skipped. */
  blocks: AgentBlockData[];
  basePath?: string;
}

/**
 * The newest step of `blocks` on one line, the head of a compact run without
 * the run: a new step scrolls in as the previous one scrolls out. A sub-agent
 * card shows what its agent did last with it.
 */
export const CompactLatestStep = memo(function CompactLatestStep({
  blocks,
  basePath,
}: CompactLatestStepProps) {
  const steps = useMemo(() => blocks.filter(hasCompactLine), [blocks]);
  const newest = steps.at(-1);
  const { handOver, endHandOver } = useHeadHandOver(newest?.id);
  if (!newest) return null;
  return (
    <CompactFlowHead
      newest={newest}
      entering={handOver?.enteringId === newest.id}
      leaving={handOver ? steps.find((block) => block.id === handOver.leavingId) : undefined}
      onHandedOver={endHandOver}
      basePath={basePath}
    />
  );
});

interface HeadHandOver {
  enteringId: string;
  leavingId: string;
}

/**
 * The step scrolling into the head line and the one scrolling out. Lives in
 * the row, not the head: the head's wrapper turns from a div into a button
 * when a run's second step arrives, and that remount must not lose the
 * hand-over. It ends with the animation, so a pane shown again (a parked tab
 * leaves `display: none`, which restarts CSS animations) does not replay it;
 * one cut short by hiding restarts on show and still ends.
 * A row (re)mounted by the virtualizer or a history load starts still, and so
 * does every swap when animations are off.
 */
function useHeadHandOver(newestId: string | undefined) {
  const [shownId, setShownId] = useState(newestId);
  const [handOver, setHandOver] = useState<HeadHandOver | null>(null);
  if (shownId !== newestId) {
    setShownId(newestId);
    setHandOver(
      animationsDisabled() || !shownId || !newestId
        ? null
        : { enteringId: newestId, leavingId: shownId },
    );
  }
  const endHandOver = useCallback(() => setHandOver(null), []);
  return { handOver, endHandOver };
}

interface CompactFlowHeadProps {
  newest: AgentBlockData;
  entering: boolean;
  /** The step scrolling out, resolved from the run so it shows its final arguments. */
  leaving: AgentBlockData | undefined;
  onHandedOver: () => void;
  basePath?: string;
}

/** The run's newest step; a new one scrolls in from below as the previous scrolls out the top. */
function CompactFlowHead({
  newest,
  entering,
  leaving,
  onHandedOver,
  basePath,
}: CompactFlowHeadProps) {
  return (
    // Clip vertically only: the outgoing line may be wider than the new one.
    <span className="relative flex min-w-0 [clip-path:inset(0_-100vw)]">
      <span
        key={newest.id}
        data-block-id={newest.id}
        onAnimationEnd={entering ? onHandedOver : undefined}
        className={cn("flex min-w-0", entering && "[animation:var(--animate-step-in)]")}
      >
        <CompactToolLine block={newest} basePath={basePath} />
      </span>
      {leaving && (
        <span
          key={leaving.id}
          data-leaving-step
          aria-hidden
          onAnimationEnd={onHandedOver}
          className="pointer-events-none absolute top-0 left-0 flex whitespace-nowrap [animation:var(--animate-step-out)]"
        >
          <CompactToolLine block={leaving} basePath={basePath} />
        </span>
      )}
    </span>
  );
}

const HEAD_CLASS = "flex h-6 w-fit max-w-full min-w-0 items-center gap-2 px-1 text-left";
