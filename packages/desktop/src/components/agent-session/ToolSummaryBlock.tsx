import { memo, useMemo, useState } from "react";
import { ChevronRightIcon, ChevronUpIcon, WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildToolChips } from "@/components/agentStreamToolChips";
import { NumStat } from "@/components/NumStat";
import { TOOL_ACCENT_CLASSES } from "@/lib/tool-accent";
import type { AgentBlockData } from "@/types/agent-block";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { AgentStreamItem } from "./AgentStreamItem";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";
import type { ToolChip } from "@/components/agentStreamToolChips";

const EMPTY_BLOCKS: AgentBlockData[] = [];
const EMPTY_TOOL_RESULT_MAP: Map<string, AgentBlockData> = new Map();

/** Shared typography for the header hint and footer button collapse affordances. */
const COLLAPSE_LABEL_CLASS =
  "text-[10px] font-medium uppercase tracking-wide text-muted-foreground";

/** One recap pill: tool label, its run count, and (for edits) the aggregate numstat. */
function SummaryToolChip({ chip }: { chip: ToolChip }): React.JSX.Element {
  const accent = TOOL_ACCENT_CLASSES[chip.accent];
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5", accent.wrapper)}
    >
      {chip.mcpServer && (
        <span className="rounded-sm bg-primary/20 px-1 text-[9px] font-semibold uppercase leading-normal tracking-wide text-primary">
          {chip.mcpServer}
        </span>
      )}
      <span className={cn("font-medium", accent.label)}>{chip.label}</span>
      {(chip.additions > 0 || chip.deletions > 0) && (
        <NumStat additions={chip.additions} deletions={chip.deletions} hideZero />
      )}
      <span className="text-muted-foreground tabular-nums">×{chip.count}</span>
    </span>
  );
}

interface ToolSummaryBlockProps {
  /** The turn's detail (every block except its final message) to reveal inline. */
  childBlocks?: AgentBlockData[];
  basePath?: string;
  /**
   * Result map from the parent stream (keyed by `toolUseId`). Built over all
   * blocks, so it is a strict superset of anything reachable from `childBlocks`
   * — the revealed tools resolve their output straight from it.
   */
  toolResultMap?: Map<string, AgentBlockData>;
  verbosityMode?: AgentVerbosityMode;
}

/**
 * "Summary mode" recap row: a single container that folds a whole turn's tool
 * calls into per-tool counts (e.g. `Read ×5`, `Bash ×12`). Tool groups are
 * derived automatically from the turn's blocks — no hardcoded tool list — so
 * new tools appear without any change here.
 *
 * Clicking the header reveals the full turn (all tools + text) inline via an
 * animated collapsible, then re-collapses it. The reveal uses the shared
 * `CollapsibleSection` (grid-rows height animation), so it honours the global
 * `html[data-animations="off"]` kill-switch automatically. Expansion happens
 * inside this one row — it does not add/remove list rows — so scroll anchoring
 * is untouched.
 */
export const ToolSummaryBlock = memo(function ToolSummaryBlock({
  childBlocks,
  basePath,
  toolResultMap,
  verbosityMode,
}: ToolSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const detail = childBlocks ?? EMPTY_BLOCKS;
  // Recap chips are derived here (not upstream) so the diff parse for numstat
  // only runs for the recaps Virtuoso actually mounts, and re-memoizes per turn.
  const chips = useMemo(() => buildToolChips(detail), [detail]);
  if (chips.length === 0) return null;

  const total = chips.reduce((sum, chip) => sum + chip.count, 0);
  const canExpand = detail.length > 0;

  const toggle = (): void => {
    if (!canExpand) return;
    // Keep the viewport put while the height animates instead of re-pinning.
    suppressAutoScrollPin();
    setExpanded((prev) => !prev);
  };

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        disabled={!canExpand}
        className={cn(
          // No fill anywhere — just the container's thin neutral border. A
          // subtle neutral hover gives click affordance without adding color.
          "group flex w-full flex-wrap items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors",
          canExpand && "hover:bg-muted/50",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-foreground transition-transform duration-200",
            expanded && "rotate-90",
            !canExpand && "opacity-0",
          )}
        />
        <WrenchIcon className="size-3 shrink-0 text-foreground" />
        <span className="font-medium text-foreground">Tools used</span>
        <span className="text-muted-foreground tabular-nums">· {total}</span>
        <span className="mx-1 h-3 w-px bg-border" aria-hidden />
        {chips.map((chip) => (
          <SummaryToolChip key={chip.key} chip={chip} />
        ))}
        {canExpand && (
          <span
            className={cn(
              COLLAPSE_LABEL_CLASS,
              "ml-auto shrink-0 pl-2 opacity-0 transition-opacity group-hover:opacity-100",
            )}
          >
            {expanded ? "Collapse" : "Expand"}
          </span>
        )}
      </button>
      <CollapsibleSection open={expanded}>
        <div className="border-t border-border px-3 py-1">
          {detail.map((block) => (
            <AgentStreamItem
              key={block.id}
              block={block}
              basePath={basePath}
              toolResultMap={toolResultMap ?? EMPTY_TOOL_RESULT_MAP}
              verbosityMode={verbosityMode}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={toggle}
          className={cn(
            COLLAPSE_LABEL_CLASS,
            "flex w-full items-center justify-center gap-1 border-t border-border px-3 py-1.5 transition-colors hover:bg-muted/50 hover:text-foreground",
          )}
        >
          <ChevronUpIcon className="size-3 shrink-0" />
          Collapse
        </button>
      </CollapsibleSection>
    </div>
  );
});
