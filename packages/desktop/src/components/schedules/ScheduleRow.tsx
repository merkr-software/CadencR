import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useMemo, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  CirclePlay,
  MessageSquarePlus,
  MessagesSquare,
  Pause,
  Pencil,
  Play,
  Repeat,
  Send,
  SquareTerminal,
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
  isActionSchedule,
  schedulePromptPreview,
  scheduleTitle,
} from "@/lib/schedules/format";
import { describeLastCheck } from "@/lib/schedules/condition";
import { scheduleState, scheduleStateLabel, type ScheduleState } from "@/lib/schedules/status";
import { cn } from "@/lib/utils";

/** Each state owns a token-backed dot colour; the dot is the meaning. */
const STATE_DOT: Record<ScheduleState, string> = {
  upcoming: "bg-primary",
  failed: "bg-destructive",
  paused: "bg-muted-foreground/50",
  completed: "bg-muted-foreground/30",
};

/** A custom action is a shell command, so it shares the condition's glyph. */
const TARGET_ICONS: Record<Schedule["target"]["kind"], typeof MessagesSquare> = {
  conversation: MessagesSquare,
  new_conversation: MessageSquarePlus,
  custom_action: SquareTerminal,
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
  const { t, i18n } = useUiTranslation();
  const state = scheduleState(schedule);
  const statusLabel = scheduleStateLabel(t, state);
  const nextRun = useMemo(
    () => (schedule.next_run_at ? new Date(schedule.next_run_at) : null),
    [schedule.next_run_at],
  );
  useCountdownTick(state === "upcoming" ? nextRun : null);

  const TargetIcon = TARGET_ICONS[schedule.target.kind];
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
        aria-label={statusLabel}
        title={statusLabel}
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {scheduleTitle(schedule)}
          </span>
          {state !== "upcoming" && (
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
              {statusLabel}
            </span>
          )}
        </div>

        {/* The prompt (or action) itself, when the name isn't already it — two
            schedules on the same rule are told apart by what they do. */}
        {schedule.name?.trim() && (
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground/90"
            title={isActionSchedule(schedule) ? undefined : schedule.prompt}
          >
            {schedulePromptPreview(schedule)}
          </p>
        )}

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <RecurrenceIcon className="size-3" />
            {describeRecurrence(schedule.recurrence, i18n.language)}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1">
            <TargetIcon className="size-3 shrink-0" />
            <span className="truncate">{describeTarget(schedule)}</span>
          </span>
          {schedule.condition && <ConditionLabel t={t} command={schedule.condition.command} />}
        </div>

        <NextRunLine schedule={schedule} state={state} nextRun={nextRun} />
        {/* A check that couldn't run is also a failed run, which the line
            above already explains. */}
        {schedule.last_check && schedule.last_check.status !== "error" && state !== "completed" && (
          <p className="mt-0.5 text-xs text-muted-foreground/80">
            {describeLastCheck(schedule.last_check, i18n.language)}
          </p>
        )}
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

function ConditionLabel({ t, command }: { t: UiTranslator; command: string }): ReactElement {
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      title={t(
        "schedule.list.scheduleRow.onlySendsOnNonZeroExit",
        "Only sends when `{{command}}` exits non-zero",
        { command },
      )}
    >
      <SquareTerminal className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        <UiTrans
          i18nKey="schedule.list.scheduleRow.ifCommandFails"
          defaults="If <command>{{command}}</command> fails"
          values={{ command }}
          components={{ command: <code className="font-mono text-[11px] text-foreground/80" /> }}
        />
      </span>
    </span>
  );
}

function NextRunLine({
  schedule,
  state,
  nextRun,
}: {
  schedule: Schedule;
  state: ScheduleState;
  nextRun: Date | null;
}): ReactElement | null {
  const { t, i18n } = useUiTranslation();
  const locale = i18n.language;
  // A failed run is the most important thing on the row: show why, and keep a
  // link to where it was supposed to land.
  if (state === "failed" && schedule.last_run?.error) {
    return (
      <p className="mt-1 truncate text-xs text-destructive" title={schedule.last_run.error}>
        {t("schedule.list.scheduleRow.lastRunFailed", "Last run failed: {{error}}", {
          error: schedule.last_run.error,
        })}
      </p>
    );
  }
  if (state === "completed" || state === "paused") {
    return (
      <p className="mt-1 text-xs text-muted-foreground/80">
        {state === "paused" && nextRun
          ? t("schedule.list.scheduleRow.pausedUntil", "Paused — would run {{when}}", {
              when: formatAbsolute(nextRun, locale),
            })
          : lastRunLabel(t, schedule, locale)}
      </p>
    );
  }
  if (!nextRun) return null;
  return (
    <p className="mt-1 text-xs">
      <span className="text-foreground/80">
        {t("schedule.list.scheduleRow.nextRun", "Next {{when}}", {
          when: formatRelative(nextRun, locale),
        })}
      </span>
      <span className="text-muted-foreground"> · {formatAbsolute(nextRun, locale)}</span>
      {schedule.run_count > 0 && (
        <span className="text-muted-foreground">
          {" · "}
          {t("schedule.list.scheduleRow.runCount", "ran {{count, number}} times", {
            count: schedule.run_count,
            defaultValue_zero: "ran {{count, number}} times",
            defaultValue_one: "ran {{count, number}} time",
          })}
        </span>
      )}
    </p>
  );
}

function lastRunLabel(t: UiTranslator, schedule: Schedule, locale: string): string {
  if (!schedule.last_run) return t("schedule.list.scheduleRow.neverRan", "Never ran");
  const when = formatAbsolute(new Date(schedule.last_run.at), locale);
  if (schedule.last_run.status === "skipped") {
    return t("schedule.list.scheduleRow.missed", "Missed — {{when}}", { when });
  }
  return isActionSchedule(schedule)
    ? t("schedule.list.scheduleRow.ran", "Ran {{when}}", { when })
    : t("schedule.list.scheduleRow.sent", "Sent {{when}}", { when });
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
  const { t } = useUiTranslation();
  const name = scheduleTitle(schedule);
  const lastFeatureId = schedule.last_run?.feature_id;
  const projectId = schedule.context.project_id;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {lastFeatureId && projectId && (
        <ShortcutTooltip label={t("schedule.list.scheduleRow.openTheLastRun", "Open the last run")}>
          <Button asChild type="button" variant="ghost" size="icon" className="size-7">
            <Link
              to="/projects/$projectId/features/$featureId"
              params={{ projectId: String(projectId), featureId: String(lastFeatureId) }}
              aria-label={t(
                "schedule.list.scheduleRow.openTheConversationOfTheLastRun",
                "Open the conversation of the last run",
              )}
            >
              <MessagesSquare className="size-3.5" />
            </Link>
          </Button>
        </ShortcutTooltip>
      )}
      <ShortcutTooltip label={t("schedule.list.scheduleRow.runNow", "Run now")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy}
          onClick={() => onRunNow(schedule)}
          aria-label={t("schedule.list.scheduleRow.runScheduleNow", "Run {{name}} now", { name })}
        >
          {isActionSchedule(schedule) ? (
            <CirclePlay className="size-3.5" />
          ) : (
            <Send className="size-3.5" />
          )}
        </Button>
      </ShortcutTooltip>
      {state !== "completed" && (
        <ShortcutTooltip
          label={
            schedule.enabled
              ? t("schedule.list.scheduleRow.pause", "Pause")
              : t("schedule.list.scheduleRow.resume", "Resume")
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={busy}
            onClick={() => onToggle(schedule)}
            aria-label={
              schedule.enabled
                ? t("schedule.list.scheduleRow.pauseSchedule", "Pause {{name}}", { name })
                : t("schedule.list.scheduleRow.resumeSchedule", "Resume {{name}}", { name })
            }
          >
            {schedule.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </Button>
        </ShortcutTooltip>
      )}
      <ShortcutTooltip label={t("schedules.actions.edit", "Edit")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={busy}
          onClick={() => onEdit(schedule)}
          aria-label={t("schedule.list.scheduleRow.editSchedule", "Edit {{name}}", { name })}
        >
          <Pencil className="size-3.5" />
        </Button>
      </ShortcutTooltip>
    </div>
  );
}
