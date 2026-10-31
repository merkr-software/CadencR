import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { AgentBlockData } from "@/components/agent-block-types";
import { hasCompactLine } from "@/components/agentStreamDisplay";
import { countSubagentToolCalls, selectSubagentActions } from "@/components/subagent-actions";
import { useAgentSessionContext } from "@/components/agent-session/agent-session-context";
import { CompactLatestStep } from "@/components/agent-session/CompactFlowRow";
import {
  CardSection,
  ElapsedClock,
  SubagentMetaLine,
  SubagentPrompt,
  SubagentReportBody,
} from "@/components/subagents/SubagentCardParts";
import { SubagentStatusGlyph } from "@/components/subagents/SubagentStatusGlyph";
import {
  MAX_SUBAGENT_DEPTH,
  SubagentTimeline,
  type NestedSubagentRenderer,
} from "@/components/subagents/SubagentTimeline";
import { useSubagentRun } from "@/hooks/useFeatureSubagents";
import {
  subagentActionCount,
  subagentStatusSentence,
  subagentView,
  type SubagentView,
} from "@/lib/subagents/subagent-presentation";
import { subagentChildren, subagentReportFor } from "@/lib/subagents/subagent-report";
import { cn } from "@/lib/utils";

/** Inset of a nested sub-agent card under its parent. */
const CHILD_INDENT_PX = 16;

interface TaskAgentBlockProps {
  block: AgentBlockData;
  basePath?: string;
  /** Nesting depth for left indent (parent stream = 0). */
  depth?: number;
  /** Compact flow: the closed card keeps to its facts and latest action. */
  compact?: boolean;
}

/**
 * A sub-agent the agent delegated to: who it is (agent, model, effort), its
 * live status from the backend registry, and what it did last. Done, it also
 * shows its report's head (except in compact flow). Opening it shows the
 * brief, the full timeline and the report. Nested sub-agents re-enter at
 * depth + 1.
 */
export const TaskAgentBlock = memo(function TaskAgentBlock({
  block,
  basePath,
  depth = 0,
  compact = false,
}: TaskAgentBlockProps): ReactElement {
  const { featureId } = useAgentSessionContext();
  const run = useSubagentRun(featureId, block.toolUseId);
  const { toolArgs, toolName, taskComplete } = block;
  const view = useMemo(
    () => subagentView(run, { toolArgs, toolName, taskComplete }),
    [run, toolArgs, toolName, taskComplete],
  );
  const { childBlocks, id: blockId } = block;
  const children = useMemo(
    () => subagentChildren({ id: blockId, childBlocks, toolArgs }),
    [blockId, childBlocks, toolArgs],
  );
  const actions = useMemo(() => selectSubagentActions(children), [children]);
  const report = useMemo(() => subagentReportFor(view, children), [children, view]);
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const canOpen = actions.length > 0 || !!view.prompt || !!report;
  const nestOffset = Math.min(depth, MAX_SUBAGENT_DEPTH) * CHILD_INDENT_PX;
  const renderNested = useCallback<NestedSubagentRenderer>(
    (child, childDepth) => (
      <TaskAgentBlock block={child} basePath={basePath} depth={childDepth} compact={compact} />
    ),
    [basePath, compact],
  );
  return (
    <section
      data-tool-family="task"
      data-subagent-depth={depth}
      data-subagent-status={view.status}
      aria-label={`Sub-agent ${view.title}: ${subagentStatusSentence(view)}`}
      className={cn(
        "my-1 min-w-0 rounded-md border bg-(--block-task-bg)",
        view.status === "failed"
          ? "border-[color-mix(in_oklab,var(--acc-red)_50%,var(--border))]"
          : "border-border",
      )}
      style={nestOffset > 0 ? { marginLeft: nestOffset } : undefined}
    >
      <SubagentCardHeader view={view} expanded={expanded} canOpen={canOpen} onToggle={toggle} />
      <SubagentMetaLine
        view={view}
        actionCount={subagentActionCount(view, {
          shown: countSubagentToolCalls(children),
          listed: run?.actionCount,
        })}
        className="px-3 pb-2 pl-[34px]"
      />
      {expanded ? (
        <SubagentCardBody
          view={view}
          actions={actions}
          report={report}
          basePath={basePath}
          depth={depth}
          renderNested={renderNested}
        />
      ) : (
        <SubagentCardPeek actions={actions} report={compact ? null : report} basePath={basePath} />
      )}
    </section>
  );
});

const SubagentCardHeader = memo(function SubagentCardHeader({
  view,
  expanded,
  canOpen,
  onToggle,
}: {
  view: SubagentView;
  expanded: boolean;
  canOpen: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse sub-agent actions" : "Expand sub-agent actions"}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-xs focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
    >
      <SubagentStatusGlyph status={view.status} label={subagentStatusSentence(view)} />
      <span className="max-w-[40%] shrink-0 truncate text-[12.5px] font-medium text-foreground">
        {view.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{view.description}</span>
      <ElapsedClock view={view} />
      {canOpen && (
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
      )}
    </button>
  );
});

interface CardContentProps {
  view: SubagentView;
  actions: AgentBlockData[];
  report: string | null;
  basePath?: string;
  depth: number;
  renderNested: NestedSubagentRenderer;
}

/**
 * Closed card: the sub-agent's latest action, live while it runs and its last
 * once it ended, then the head of its report when one is passed.
 */
function SubagentCardPeek({
  actions,
  report,
  basePath,
}: {
  actions: AgentBlockData[];
  report: string | null;
  basePath?: string;
}): ReactElement | null {
  const latest = actions.some(hasCompactLine);
  if (!latest && !report) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 py-1 pr-3 pl-[34px]">
      {latest && (
        <div className="flex h-6 min-w-0 items-center text-xs">
          <span className="sr-only">Latest action: </span>
          <CompactLatestStep blocks={actions} basePath={basePath} />
        </div>
      )}
      {report && (
        <div className="pb-1">
          <SubagentReportBody report={report} clamp />
        </div>
      )}
    </div>
  );
}

/** Opened card: the brief, every action, the report. */
function SubagentCardBody({
  view,
  actions,
  report,
  basePath,
  depth,
  renderNested,
}: CardContentProps): ReactElement {
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 py-2.5 pr-3 pl-[34px]">
      {view.prompt && <SubagentPrompt prompt={view.prompt} />}
      {actions.length > 0 && (
        <CardSection label={`Activity · ${actions.length}`}>
          <SubagentTimeline
            actions={actions}
            basePath={basePath}
            depth={depth}
            description={view.description ?? view.title}
            isRunning={view.status === "running"}
            renderNested={renderNested}
          />
        </CardSection>
      )}
      {report && (
        <CardSection label="Report">
          <SubagentReportBody report={report} />
        </CardSection>
      )}
    </div>
  );
}
