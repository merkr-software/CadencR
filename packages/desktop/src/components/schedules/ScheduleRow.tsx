import { memo, useMemo, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  MessageSquarePlus,
  MessagesSquare,
  Pause,
  Pencil,
  Play,
  Repeat,
  Send,
} from "lucide-react";
import type { Schedule } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useCountdownTick } from "@/hooks/useCountdownTick";
import {
  describeRecurrence,
  describeTarget,
  formatAbsolute,
  formatRelative,
  schedulePromptPreview,
  scheduleTitle,
} from "@/lib/schedules/format";
import { scheduleState, SCHEDULE_STATE_LABELS, type ScheduleState } from "@/lib/schedules/status";
import { cn } from "@/lib/utils";

/** Each state owns a token-backed dot colour; the dot is the meaning. */
const STATE_DOT: Record<ScheduleState, string> = {
  upcoming: "bg-primary",
  failed: "bg-destructive",
  paused: "bg-muted-foreground/50",
  completed: "bg-muted-foreground/30",
};

export interface ScheduleRowProps {
  schedule: Schedule;
  onEdit: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onRunNow: (schedule: Schedule) => void;
  busy: boolean;
}

export const ScheduleRow = memo(function ScheduleRow({
  schedule,
  onEdit,
  onToggle,
  onRunNow,
  busy,
}: ScheduleRowProps): ReactElement {
  const state = scheduleState(schedule);
  const nextRun = useMemo(
    () => (schedule.next_run_at ? new Date(schedule.next_run_at) : null),
    [schedule.next_run_at],
  );
  useCountdownTick(state === "upcoming" ? nextRun : null);

  const TargetIcon =
    schedule.target.kind === "new_conversation" ? MessageSquarePlus : MessagesSquare;
  const RecurrenceIcon = schedule.recurrence.kind === "once" ? CalendarClock : Repeat;

  return (
    <li
      className={cn(
        "group flex items-start gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 transition-colors",
        "hover:border-border hover:bg-card/70",
        state === "completed" && "opacity-60",
      )}
    >
      <span
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATE_DOT[state])}
        aria-label={SCHEDULE_STATE_LABELS[state]}
        title={SCHEDULE_STATE_LABELS[state]}
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {scheduleTitle(schedule)}
          </span>
          {state !== "upcoming" && (
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
              {SCHEDULE_STATE_LABELS[state]}
            </span>
          )}
        </div>

        {/* The prompt itself, when the name isn't already it — two schedules on
            the same rule are told apart by what they send. */}
        {schedule.name?.trim() && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/90" title={schedule.prompt}>
            {schedulePromptPreview(schedule)}
          </p>
        )}

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <RecurrenceIcon className="size-3" />
            {describeRecurrence(schedule.recurrence)}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <TargetIcon className="size-3 shrink-0" />
            <span className="truncate">{describeTarget(schedule)}</span>
          </span>
        </div>

        <NextRunLine schedule={schedule} state={state} nextRun={nextRun} />
      </div>

      <RowActions
        schedule={schedule}
        state={state}
        busy={busy}
        onEdit={onEdit}
        onToggle={onToggle}
        onRunNow={onRunNow}
      />
    </li>
  );
});

function NextRunLine({
  schedule,
  state,
  nextRun,
}: {
  schedule: Schedule;
  state: ScheduleState;
  nextRun: Date | null;
}): ReactElement | null {
  // A failed run is the most important thing on the row: show why, and keep a
  // link to where it was supposed to land.
  if (state === "failed" && schedule.last_run?.error) {
    return (
      <p className="mt-1 truncate text-xs text-destructive" title={schedule.last_run.error}>
        Last run failed: {schedule.last_run.error}
      </p>
    );
  }
  if (state === "completed" || state === "paused") {
    return (
      <p className="mt-1 text-xs text-muted-foreground/80">
        {state === "paused" && nextRun
          ? `Paused — would run ${formatAbsolute(nextRun)}`
          : lastRunLabel(schedule)}
      </p>
    );
  }
  if (!nextRun) return null;
  return (
    <p className="mt-1 text-xs">
      <span className="text-foreground/80">Next {formatRelative(nextRun)}</span>
      <span className="text-muted-foreground"> · {formatAbsolute(nextRun)}</span>
      {schedule.run_count > 0 && (
        <span className="text-muted-foreground">
          {" "}
          · ran {schedule.run_count} {schedule.run_count === 1 ? "time" : "times"}
        </span>
      )}
    </p>
  );
}

function lastRunLabel(schedule: Schedule): string {
  if (!schedule.last_run) return "Never ran";
  const at = formatAbsolute(new Date(schedule.last_run.at));
  return schedule.last_run.status === "skipped" ? `Missed — ${at}` : `Sent ${at}`;
}

function RowActions({
  schedule,
  state,
  busy,
  onEdit,
  onToggle,
  onRunNow,
}: {
  schedule: Schedule;
  state: ScheduleState;
  busy: boolean;
  onEdit: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onRunNow: (schedule: Schedule) => void;
}): ReactElement {
  const lastFeatureId = schedule.last_run?.feature_id;
  const projectId = schedule.context.project_id;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {lastFeatureId && projectId && (
        <ShortcutTooltip label="Open the last run">
          <Button asChild type="button" variant="ghost" size="icon" className="size-7">
            <Link
              to="/projects/$projectId/features/$featureId"
              params={{ projectId: String(projectId), featureId: String(lastFeatureId) }}
              aria-label="Open the conversation of the last run"
            >
              <MessagesSquare className="size-3.5" />
            </Link>
          </Button>
        </ShortcutTooltip>
      )}
      <ShortcutTooltip label="Run now">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy}
          onClick={() => onRunNow(schedule)}
          aria-label={`Run ${scheduleTitle(schedule)} now`}
        >
          <Send className="size-3.5" />
        </Button>
      </ShortcutTooltip>
      {state !== "completed" && (
        <ShortcutTooltip label={schedule.enabled ? "Pause" : "Resume"}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy}
            onClick={() => onToggle(schedule)}
            aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${scheduleTitle(schedule)}`}
          >
            {schedule.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
        </ShortcutTooltip>
      )}
      <ShortcutTooltip label="Edit">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy}
          onClick={() => onEdit(schedule)}
          aria-label={`Edit ${scheduleTitle(schedule)}`}
        >
          <Pencil className="size-3.5" />
        </Button>
      </ShortcutTooltip>
    </div>
  );
}
