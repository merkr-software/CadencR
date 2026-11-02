import { memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Markdown } from "@/components/Markdown";
import { CompactLatestStep } from "@/components/agent-session/CompactFlowRow";
import { hasCompactLine } from "@/lib/agent-stream-display";
import type { AgentBlockData } from "@/types/agent-block";
import { useNow } from "@/hooks/useNow";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  formatTokens,
  statusReasonLabel,
  subagentElapsedMs,
  subagentStatusSentence,
  type SubagentView,
} from "@/lib/subagents/subagent-presentation";
import { cn } from "@/lib/utils";
import { SubagentStatusGlyph } from "./SubagentStatusGlyph";

/**
 * Who a sub-agent is at a glance: status glyph, name, then its task taking
 * the rest of the line. Shared by its card header and the composer's list of
 * running agents, so a row reads like the card it leads to.
 */
export function SubagentIdentity({ view }: { view: SubagentView }): ReactElement {
  return (
    <>
      <SubagentStatusGlyph status={view.status} label={subagentStatusSentence(view)} />
      <span className="max-w-[40%] shrink-0 truncate text-[12.5px] font-medium text-foreground">
        {view.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {view.description}
      </span>
    </>
  );
}

/** The model a sub-agent runs on, titled with whether it was requested. */
export function SubagentModelLabel({
  view,
  className,
}: {
  view: SubagentView;
  className?: string;
}): ReactElement | null {
  if (!view.model) return null;
  return (
    <span
      className={cn("truncate font-mono", className)}
      title={view.modelRequested ? `Requested model ${view.model}` : `Model ${view.model}`}
    >
      {view.model}
    </span>
  );
}

/** Tags a sub-agent that keeps running after its turn ends. */
export function SubagentBackgroundTag({ className }: { className?: string }): ReactElement {
  return (
    <span
      className={cn("rounded-sm border border-border px-1 text-[10.5px] leading-[14px]", className)}
    >
      background
    </span>
  );
}

/**
 * Elapsed time, ticking once a second while the sub-agent runs. Isolated so
 * the tick re-renders this text only, never the card or its timeline.
 */
export const ElapsedClock = memo(function ElapsedClock({
  view,
  className,
}: {
  view: SubagentView;
  className?: string;
}): ReactElement | null {
  const running = view.status === "running";
  const now = useNow(running, 1_000, view.startedAtMs);
  const elapsed = subagentElapsedMs(view, now);
  if (elapsed == null) return null;
  return (
    <span
      className={cn("shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums", className)}
      title={running ? "Running for" : "Ran for"}
    >
      {formatElapsed(elapsed)}
    </span>
  );
});

/**
 * The configuration line: what the sub-agent is, what it runs on, how much
 * it did. Only facts the provider reported appear; nothing is guessed.
 */
export const SubagentMetaLine = memo(function SubagentMetaLine({
  view,
  actionCount,
  className,
}: {
  view: SubagentView;
  actionCount: number | null;
  className?: string;
}): ReactElement | null {
  return <MetaItemList items={metaItems(view, actionCount)} className={className} />;
});

export interface MetaItem {
  key: string;
  node: ReactNode;
}

/** A card's configuration facts on one dotted line; nothing when there are none. */
export function MetaItemList({
  items,
  className,
}: {
  items: MetaItem[];
  className?: string;
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground",
        className,
      )}
    >
      {items.map((item, index) => (
        <span key={item.key} className="flex min-w-0 items-center gap-x-1.5">
          {index > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
          )}
          {item.node}
        </span>
      ))}
    </div>
  );
}

/** How a reasoning effort reads on a meta line. */
export function effortLabel(effort: string): string {
  return effort === "none" ? "no reasoning" : `${effort} effort`;
}

/** The frame every agent card shares; a failed one wears a red edge. */
export function agentCardClassName(failed: boolean): string {
  return cn(
    "my-1 min-w-0 rounded-md border bg-(--block-task-bg)",
    failed ? "border-[color-mix(in_oklab,var(--acc-red)_50%,var(--border))]" : "border-border",
  );
}

/**
 * Closed card: the agent's latest action, live while it runs and its last
 * once it ended, then the head of its report when one is passed.
 */
export function SubagentCardPeek({
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
    <SubagentCardPeekFrame>
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
    </SubagentCardPeekFrame>
  );
}

/** The band under a card's header where its peek sits. */
export function SubagentCardPeekFrame({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 py-1 pr-3 pl-[34px]">
      {children}
    </div>
  );
}

function metaItems(view: SubagentView, actionCount: number | null): MetaItem[] {
  const items: MetaItem[] = [];
  if (view.model) {
    items.push({
      key: "model",
      node: <SubagentModelLabel view={view} className="text-foreground/80" />,
    });
  }
  if (view.effort) {
    items.push({ key: "effort", node: <span>{effortLabel(view.effort)}</span> });
  }
  if (view.background) {
    items.push({ key: "background", node: <SubagentBackgroundTag /> });
  }
  const actions = actionCount;
  if (actions != null && actions > 0) {
    items.push({
      key: "actions",
      node: (
        <span className="tabular-nums">
          {actions} action{actions === 1 ? "" : "s"}
        </span>
      ),
    });
  }
  if (view.totalTokens != null && view.totalTokens > 0) {
    items.push({
      key: "tokens",
      node: <span className="tabular-nums">{formatTokens(view.totalTokens)}</span>,
    });
  }
  const reason = view.status === "running" ? null : statusReasonLabel(view.statusReason);
  if (view.status === "failed" || (view.status === "stopped" && reason)) {
    items.push({
      key: "reason",
      node: (
        <span
          className={cn(
            "truncate",
            view.status === "failed" ? "text-(--acc-red)" : "text-muted-foreground",
          )}
        >
          {view.status === "failed" ? `Failed${reason ? ` · ${reason}` : ""}` : reason}
        </span>
      ),
    });
  }
  return items;
}

/** A labelled section of the opened card. */
export function CardSection({
  label,
  children,
  aside,
}: {
  label: string;
  children: ReactNode;
  aside?: ReactNode;
}): ReactElement {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">{label}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The brief the parent gave, clamped until asked for in full. */
export const SubagentPrompt = memo(function SubagentPrompt({
  prompt,
}: {
  prompt: string;
}): ReactElement {
  const [full, setFull] = useState(false);
  const long = prompt.length > 320 || prompt.split("\n").length > 4;
  return (
    <CardSection
      label="Prompt"
      aside={
        long ? (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            className="rounded-sm text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
          >
            {full ? "Show less" : "Show all"}
          </button>
        ) : undefined
      }
    >
      <p
        className={cn(
          "text-xs leading-relaxed whitespace-pre-wrap text-foreground/85",
          !full && "line-clamp-4",
          full && "max-h-72 overflow-y-auto",
        )}
      >
        {prompt}
      </p>
    </CardSection>
  );
});

/** The sub-agent's final report, rendered as the markdown it is. */
export const SubagentReportBody = memo(function SubagentReportBody({
  report,
  clamp,
}: {
  report: string;
  clamp?: boolean;
}): ReactElement {
  // Two clamped lines never show more than the report's opening lines: only
  // those are parsed, not a long report with its code blocks.
  const content = useMemo(() => (clamp ? reportHead(report) : report), [clamp, report]);
  return (
    <div
      className={cn(
        // A report sits inside a card: its headings stay at the card's scale.
        "min-w-0 text-xs leading-relaxed text-foreground/85 [&_:is(p,li,td,th)]:text-xs [&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-xs [&_:is(h1,h2,h3)]:mt-2 [&_:is(h1,h2,h3)]:mb-1 [&_p]:my-1 [&_pre]:my-1.5 [&_pre]:text-[11px]",
        clamp && "line-clamp-2 [&_*]:my-0 [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-xs",
      )}
    >
      <Markdown content={content} />
    </div>
  );
});

const REPORT_HEAD_CHARS = 400;

/** The report's opening lines, up to its first code fence. */
function reportHead(report: string): string {
  const lines: string[] = [];
  let length = 0;
  for (const line of report.trim().split(/\r?\n/)) {
    if (length >= REPORT_HEAD_CHARS || line.trimStart().startsWith("```")) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length > 0 ? lines.join("\n") : report.slice(0, REPORT_HEAD_CHARS);
}
