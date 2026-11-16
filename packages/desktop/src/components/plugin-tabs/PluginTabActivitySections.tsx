import type { ReactElement, ReactNode } from "react";
import { Loader2Icon, SquareIcon } from "lucide-react";

import type { PluginTabBackendStatus, PluginTabExecRecord } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { formatAgo } from "@/lib/date-utils";
import { cn } from "@/lib/utils";

import { reasonClause } from "./plugin-tab-access";

export function ActivitySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

// Literal class strings: Tailwind only emits arbitrary values it finds verbatim.
const OUTCOME_TONE: Record<PluginTabExecRecord["outcome"], string> = {
  exited: "text-muted-foreground",
  refused: "text-[var(--acc-red)]",
  timed_out: "text-[var(--acc-orange)]",
  failed: "text-[var(--acc-red)]",
};

function outcomeText(record: PluginTabExecRecord): string {
  switch (record.outcome) {
    case "exited":
      return record.exit_code == null ? "Ended by a signal" : `Exit ${record.exit_code}`;
    case "refused":
      return "Refused";
    case "timed_out":
      return "Timed out";
    case "failed":
      return "Failed";
  }
}

/** Every command the tab asked for here, newest first, refusals included. */
export function CommandList({ records }: { records: PluginTabExecRecord[] }): ReactElement {
  if (records.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No command has run in this conversation yet.</p>
    );
  }
  return (
    <ul
      className="divide-y divide-border/60 rounded-md border border-border"
      aria-label="Commands run"
    >
      {records.map((record, index) => (
        <li key={`${record.started_at}-${index}`} className="space-y-0.5 px-3 py-2">
          <p className="break-all font-mono text-[11.5px] text-foreground">
            {[record.program, ...record.args].join(" ")}
          </p>
          <p className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
            <span className={cn("font-medium", OUTCOME_TONE[record.outcome])}>
              {outcomeText(record)}
            </span>
            <span>{record.duration_ms} ms</span>
            <span>{formatAgo(record.started_at)}</span>
          </p>
          {record.error ? (
            <p className="text-[11px] text-[var(--acc-red)]">{record.error}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function backendHeadline(status: PluginTabBackendStatus | null | undefined): string {
  if (!status) return "Not started yet: it starts on the tab's first request.";
  // A refused start spawned nothing: the last run's exit no longer says why it isn't running.
  if (status.state === "stopped" && status.start_error)
    return `Couldn't start: ${reasonClause(status.start_error)}.`;
  const since = formatAgo(status.state === "running" ? status.started_at : status.exited_at);
  switch (status.state) {
    case "starting":
      return `Starting… waiting for ${status.pid ? `process ${status.pid}` : "it"} to be ready.`;
    case "running":
      return `Running${status.pid ? ` as process ${status.pid}` : ""}${since ? `, started ${since}` : ""}.`;
    case "crashed":
      return `Crashed${since ? ` ${since}` : ""}: ${status.exit_reason ?? "it exited with an error"}.`;
    case "stopped":
      return `Stopped${since ? ` ${since}` : ""}: ${status.exit_reason ?? "not running"}.`;
  }
}

/**
 * The backend's state, its stderr tail and the one control the user has:
 * stop it, or — once Cadencr holds its starts (crash loop, protocol
 * mismatch, refused starts) — allow a restart.
 */
export function BackendPanel({
  status,
  stopping,
  onStop,
}: {
  status: PluginTabBackendStatus | null | undefined;
  stopping: boolean;
  onStop: () => void;
}): ReactElement {
  const running = status?.state === "running";
  const crashed = status?.state === "crashed";
  const starting = status?.state === "starting";
  const held = status?.restart_held === true;
  const failing = crashed || held;
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p
          role={starting ? "status" : undefined}
          className={cn(
            // An exit reason can quote a long unbroken line (a protocol
            // mismatch): wrap it rather than push the button out.
            "min-w-0 flex-1 text-xs leading-snug [overflow-wrap:anywhere]",
            failing ? "text-[var(--acc-red)]" : "text-foreground",
          )}
        >
          {starting ? (
            <Loader2Icon
              aria-hidden
              className="mr-1.5 inline size-3.5 animate-spin align-[-3px] text-muted-foreground"
            />
          ) : null}
          {backendHeadline(status)}
          {held ? (
            <span className="text-muted-foreground">
              {" "}
              Cadencr won't start it again until you allow a restart.
            </span>
          ) : null}
          {status && status.starts > 1 ? (
            <span className="text-muted-foreground"> Started {status.starts} times.</span>
          ) : null}
        </p>
        {running || failing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onStop}
            disabled={stopping}
          >
            {stopping ? (
              <Loader2Icon className="animate-spin" aria-hidden />
            ) : (
              <SquareIcon aria-hidden />
            )}
            {running ? "Stop" : "Allow restart"}
          </Button>
        ) : null}
      </div>
      {status && status.stderr_tail.length > 0 ? (
        <pre
          aria-label="Backend log"
          className="max-h-48 overflow-auto rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground"
        >
          {status.stderr_tail.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
