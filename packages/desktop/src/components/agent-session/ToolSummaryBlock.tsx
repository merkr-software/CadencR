import { memo, useState } from "react";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolSummaryCount } from "@/components/agentStreamSummary";
import type { AgentBlockData } from "@/components/AgentBlock";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { suppressAutoScrollPin } from "@/lib/agent-scroll-suppression";
import { AgentStreamItem } from "./AgentStreamItem";
import type { AgentVerbosityMode } from "@/lib/agent-verbosity";

const EMPTY_COUNTS: ToolSummaryCount[] = [];
const EMPTY_BLOCKS: AgentBlockData[] = [];
const EMPTY_TOOL_RESULT_MAP: Map<string, AgentBlockData> = new Map();

interface ToolSummaryBlockProps {
  /** Per-tool counts for the recap (grouped automatically upstream). */
  counts?: ToolSummaryCount[];
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
  counts = EMPTY_COUNTS,
  childBlocks,
  basePath,
  toolResultMap,
  verbosityMode,
}: ToolSummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const detail = childBlocks ?? EMPTY_BLOCKS;
  if (counts.length === 0) return null;

  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
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
        {counts.map((entry) => (
          <span
            key={entry.name}
            className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5"
          >
            <span className="font-medium text-foreground/80">{entry.name}</span>
            <span className="text-muted-foreground tabular-nums">×{entry.count}</span>
          </span>
        ))}
        {canExpand && (
          <span className="ml-auto shrink-0 pl-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
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
      </CollapsibleSection>
    </div>
  );
});
