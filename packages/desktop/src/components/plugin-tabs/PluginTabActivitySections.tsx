import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
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

function outcomeText(record: PluginTabExecRecord, t: UiTranslator): string {
  switch (record.outcome) {
    case "exited":
      return record.exit_code == null
        ? t("customTabs.activity.endedBySignal", "Ended by a signal")
        : t("customTabs.activity.exitCode", "Exit {{code}}", { code: record.exit_code });
    case "refused":
      return t("customTabs.activity.refused", "Refused");
    case "timed_out":
      return t("customTabs.activity.timedOut", "Timed out");
    case "failed":
      return t("customTabs.activity.failed", "Failed");
  }
}

/** Every command the tab asked for here, newest first, refusals included. */
export function CommandList({ records }: { records: PluginTabExecRecord[] }): ReactElement {
  const { t } = useUiTranslation();
  if (records.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          "customTabs.pluginTabActivitySections.noCommandHasRunInThisConversation",
          "No command has run in this conversation yet.",
        )}
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-border/60 rounded-md border border-border"
      aria-label={t("customTabs.pluginTabActivitySections.commandsRun", "Commands run")}
    >
      {records.map((record, index) => (
        <li key={`${record.started_at}-${index}`} className="space-y-0.5 px-3 py-2">
          <p className="break-all font-mono text-[11.5px] text-foreground">
            {[record.program, ...record.args].join(" ")}
          </p>
          <p className="flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
            <span className={cn("font-medium", OUTCOME_TONE[record.outcome])}>
              {outcomeText(record, t)}
            </span>
            <span>
              {t("customTabs.activity.duration", "{{duration}} ms", {
                duration: record.duration_ms,
              })}
            </span>
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

function backendHeadline(
  status: PluginTabBackendStatus | null | undefined,
  t: UiTranslator,
): string {
  if (!status)
    return t(
      "customTabs.activity.backendNotStarted",
      "Not started yet: it starts on the tab's first request.",
    );
  // A refused start spawned nothing: the last run's exit no longer says why it isn't running.
  if (status.state === "stopped" && status.start_error)
    return t("customTabs.activity.backendStartError", "Couldn't start: {{reason}}.", {
      reason: reasonClause(status.start_error),
    });
  const since = formatAgo(status.state === "running" ? status.started_at : status.exited_at);
  switch (status.state) {
    case "starting":
      return status.pid
        ? t(
            "customTabs.activity.backendStartingPid",
            "Starting… waiting for process {{pid}} to be ready.",
            { pid: status.pid },
          )
        : t("customTabs.activity.backendStarting", "Starting… waiting for it to be ready.");
    case "running":
      if (status.pid) {
        return since
          ? t(
              "customTabs.activity.backendRunningPidSince",
              "Running as process {{pid}}, started {{since}}.",
              { pid: status.pid, since },
            )
          : t("customTabs.activity.backendRunningPid", "Running as process {{pid}}.", {
              pid: status.pid,
            });
      }
      return since
        ? t("customTabs.activity.backendRunningSince", "Running, started {{since}}.", { since })
        : t("customTabs.activity.backendRunning", "Running.");
    case "crashed": {
      const reason =
        status.exit_reason ??
        t("customTabs.activity.backendCrashReason", "it exited with an error");
      return since
        ? t("customTabs.activity.backendCrashedSince", "Crashed {{since}}: {{reason}}.", {
            since,
            reason,
          })
        : t("customTabs.activity.backendCrashed", "Crashed: {{reason}}.", { reason });
    }
    case "stopped": {
      const reason =
        status.exit_reason ?? t("customTabs.activity.backendStopReason", "not running");
      return since
        ? t("customTabs.activity.backendStoppedSince", "Stopped {{since}}: {{reason}}.", {
            since,
            reason,
          })
        : t("customTabs.activity.backendStopped", "Stopped: {{reason}}.", { reason });
    }
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
  const { t } = useUiTranslation();
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
          {backendHeadline(status, t)}
          {held ? (
            <span className="text-muted-foreground">
              {" "}
              {t(
                "customTabs.activity.restartHeld",
                "Cadencr won't start it again until you allow a restart.",
              )}
            </span>
          ) : null}
          {status && status.starts > 1 ? (
            <span className="text-muted-foreground">
              {" "}
              {t("customTabs.activity.startCount", {
                count: status.starts,
                defaultValue_zero: "Started {{count}} times.",
                defaultValue_one: "Started {{count}} time.",
                defaultValue_other: "Started {{count}} times.",
              })}
            </span>
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
            {running
              ? t("customTabs.activity.stop", "Stop")
              : t("customTabs.activity.allowRestart", "Allow restart")}
          </Button>
        ) : null}
      </div>
      {status && status.stderr_tail.length > 0 ? (
        <pre
          aria-label={t("customTabs.pluginTabActivitySections.backendLog", "Backend log")}
          className="max-h-48 overflow-auto rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-muted-foreground"
        >
          {status.stderr_tail.join("\n")}
        </pre>
      ) : null}
    </div>
  );
}
