import { memo, type ReactElement } from "react";
import type { AttentionState } from "@/lib/sidebar-attention";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { rowLayout } from "@/lib/sidebar-row-summary";
import { cn } from "@/lib/utils";

type SketchState = Extract<AttentionState, "working" | "waiting" | "idle">;

interface SketchRow {
  state: SketchState;
  /** Title bar width, in percent of the row. */
  title: number;
  /** Long enough to take a second line when titles take two. */
  long?: boolean;
}

const ROWS: readonly SketchRow[] = [
  { state: "working", title: 78, long: true },
  { state: "waiting", title: 56 },
  { state: "idle", title: 68 },
];

const ROW_PAD: Record<SidebarConfig["density"], string> = {
  compact: "py-px",
  comfortable: "py-0.5",
  spacious: "py-[3px]",
};

/**
 * A preset drawn as a tiny sidebar: a project and three of its conversations
 * (working, waiting, idle), every bar standing for what the configuration
 * shows. Derived from the config and laid out by the rows' own `rowLayout`, so
 * a preset's sketch never drifts from the sidebar it makes.
 */
export const SidebarPresetSketch = memo(function SidebarPresetSketch({
  config,
  className,
}: {
  config: SidebarConfig;
  className?: string;
}): ReactElement {
  return (
    <div
      aria-hidden
      className={cn(
        "flex flex-col gap-1 overflow-hidden rounded-md border border-border/50 bg-sidebar px-2 pt-1.5 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
        className,
      )}
    >
      {config.workingBlock && <SketchBlock tone="bg-blue-500" />}
      {config.recentBlock && <SketchBlock tone="bg-muted-foreground/60" />}
      <div className="flex h-2 items-center gap-1">
        <span className="size-1.5 shrink-0 rounded-[2px] bg-foreground/45" />
        <span className="h-[3px] w-8 rounded-full bg-foreground/70" />
      </div>
      <div className="ml-[3px] flex flex-col border-l border-border/70 pl-1.5">
        {ROWS.map((row) => (
          <SketchConversation key={row.state} config={config} row={row} />
        ))}
      </div>
    </div>
  );
});

/** An In progress or Recent block: its eyebrow over a hairline. */
function SketchBlock({ tone }: { tone: string }): ReactElement {
  return (
    <div className="flex h-2 items-center gap-1 border-b border-border/50 pb-1">
      <span className={cn("size-1 shrink-0 rounded-full", tone)} />
      <span className="h-[2px] w-6 rounded-full bg-muted-foreground/50" />
    </div>
  );
}

function SketchConversation({
  config,
  row,
}: {
  config: SidebarConfig;
  row: SketchRow;
}): ReactElement {
  const layout = rowLayout(config, row.state, false);
  const details = !layout.compact && row.state === "working" && hasDetails(config);
  const inlineDetails = details && layout.foldMeta;
  return (
    <div className={cn("flex flex-col gap-[3px]", ROW_PAD[config.density])}>
      <div className="flex h-2 items-center gap-1">
        <SketchStatus style={config.status} state={row.state} />
        <span className="flex min-w-0 flex-1">
          <span
            className={cn(
              "h-[3px] rounded-full",
              row.state === "idle" ? "bg-foreground/35" : "bg-foreground/60",
            )}
            style={{ width: `${row.title}%` }}
          />
        </span>
        {inlineDetails && <SketchDetails config={config} />}
        {config.time !== "none" && (
          <span
            className={cn(
              "h-[2px] shrink-0 rounded-full bg-muted-foreground/45",
              config.time === "absolute" ? "w-3" : "w-1.5",
            )}
          />
        )}
        {config.provider !== "hidden" && (
          <span className="size-1.5 shrink-0 rounded-[2px] bg-foreground/25" />
        )}
      </div>
      <div className="flex flex-col gap-[3px] pl-3">
        {row.long && config.titleLines === "two" && !layout.fixed && (
          <SketchLine width={42} tone="bg-foreground/60" />
        )}
        {details && !inlineDetails && <SketchDetails config={config} />}
        {row.state === "waiting" && config.pendingRequest && (
          <SketchLine width={62} tone="bg-amber-400/70" />
        )}
        {layout.showsPreview && <SketchLine width={88} tone="bg-foreground/15" />}
        {layout.showsTodos && row.state === "working" && <SketchTodos />}
      </div>
    </div>
  );
}

function hasDetails(config: SidebarConfig): boolean {
  return (
    config.branch || config.diff || config.pr || config.ports || config.provider === "logo_model"
  );
}

/** The worktree's details: branch, model, diff, PR and ports as small marks. */
function SketchDetails({ config }: { config: SidebarConfig }): ReactElement {
  return (
    <span className="flex h-2 shrink-0 items-center gap-[3px]">
      {config.branch && <span className="h-[2px] w-5 rounded-full bg-muted-foreground/55" />}
      {config.provider === "logo_model" && (
        <span className="h-[2px] w-3 rounded-full bg-muted-foreground/45" />
      )}
      {config.diff && (
        <>
          <span className="h-[2px] w-1.5 rounded-full bg-[var(--acc-green)]/80" />
          <span className="h-[2px] w-1 rounded-full bg-[var(--acc-red)]/80" />
        </>
      )}
      {config.pr && <span className="size-1 rounded-full bg-primary/70" />}
      {config.ports && <span className="h-[2px] w-2 rounded-full bg-foreground/30" />}
    </span>
  );
}

function SketchLine({ width, tone }: { width: number; tone: string }): ReactElement {
  return <span className={cn("h-[2px] rounded-full", tone)} style={{ width: `${width}%` }} />;
}

function SketchTodos(): ReactElement {
  return (
    <span className="flex h-[2px] w-6 overflow-hidden rounded-full bg-foreground/15">
      <span className="w-3/5 bg-foreground/45" />
    </span>
  );
}

function SketchStatus({
  style,
  state,
}: {
  style: SidebarConfig["status"];
  state: SketchState;
}): ReactElement {
  return (
    <span className="flex size-2 shrink-0 items-center justify-center">
      <span className={statusMark(style, state)} />
    </span>
  );
}

/** The status slot's mark; a pending request shows whatever the style, as in the sidebar. */
function statusMark(style: SidebarConfig["status"], state: SketchState): string {
  if (state === "waiting") {
    return cn("rounded-full bg-amber-400", style === "shape" ? "size-2" : "size-1.5");
  }
  if (style === "hidden") return "";
  if (state === "working") {
    return style === "dot"
      ? "size-1.5 rounded-full bg-blue-500"
      : "size-2 rounded-full border-[1.5px] border-blue-500 border-l-blue-500/25 border-b-blue-500/25";
  }
  return cn(
    "size-1 rounded-full",
    style === "dot" ? "bg-muted-foreground/50" : "bg-muted-foreground/60",
  );
}
