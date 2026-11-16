import { memo, useMemo, useState, type ReactElement } from "react";
import {
  CalendarClock,
  ChevronDown,
  Loader2,
  Pencil,
  Repeat,
  Send,
  SquareTerminal,
  X,
} from "lucide-react";
import type { Schedule } from "@/api/generated";
import {
  STACK_ROW_CLASS,
  StackList,
  StackRowActions,
  StackRowButton,
  StackSection,
} from "@/components/composer/ComposerStack";
import { useCountdownTick } from "@/hooks/useCountdownTick";
import {
  describeRecurrence,
  formatAbsolute,
  formatRelative,
  scheduleTitle,
} from "@/lib/schedules/format";
import { cn } from "@/lib/utils";

export interface SessionSchedulesBannerProps {
  /** Already filtered to the armed ones, soonest first. */
  schedules: Schedule[];
  busy: boolean;
  onEdit: (schedule: Schedule) => void;
  onCancel: (schedule: Schedule) => void;
  onSendNow: (schedule: Schedule) => void;
}

/**
 * What this conversation has scheduled, a section of the composer's stack.
 *
 * A conversation can hold several schedules, but the composer is not the
 * place to manage a list: it shows the next one and folds the rest behind
 * the header's count, so the section stays one row tall in the common case.
 */
export const SessionSchedulesBanner = memo(function SessionSchedulesBanner({
  schedules,
  busy,
  onEdit,
  onCancel,
  onSendNow,
}: SessionSchedulesBannerProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? schedules : schedules.slice(0, 1);

  if (!schedules.length) return null;

  return (
    <StackSection
      tone="schedule"
      label="Scheduled messages"
      data-composer-schedules
      icon={<CalendarClock />}
      title="Scheduled"
      count={schedules.length}
      hint="Sends to this conversation on its own"
      summary={<NextScheduleSummary schedule={schedules[0]} />}
      // Schedules come and go on their own (they fire; an agent sets one), and
      // the section moves above a permission prompt and back.
      opensOnArrival={false}
      actions={
        <>
          {busy && (
            <Loader2
              className="size-3 shrink-0 animate-spin text-muted-foreground"
              aria-label="Saving"
            />
          )}
          {schedules.length > 1 && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              className="flex shrink-0 items-center gap-1 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded ? "Show less" : `${schedules.length - 1} more`}
              <ChevronDown
                className={cn("size-3 transition-transform", expanded && "rotate-180")}
                aria-hidden
              />
            </button>
          )}
        </>
      }
    >
      <StackList>
        {visible.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            busy={busy}
            onEdit={onEdit}
            onCancel={onCancel}
            onSendNow={onSendNow}
          />
        ))}
      </StackList>
    </StackSection>
  );
});

/** The next schedule in one line; it ticks like its row would. */
function NextScheduleSummary({ schedule }: { schedule: Schedule }): ReactElement {
  const nextRun = useMemo(
    () => (schedule.next_run_at ? new Date(schedule.next_run_at) : null),
    [schedule.next_run_at],
  );
  useCountdownTick(nextRun);
  const verb = schedule.condition ? "Checks" : "Sends";
  return (
    <>
      {nextRun ? `${verb} ${formatRelative(nextRun)}` : verb} · {scheduleTitle(schedule)}
    </>
  );
}

function ScheduleRow({
  schedule,
  busy,
  onEdit,
  onCancel,
  onSendNow,
}: {
  schedule: Schedule;
  busy: boolean;
  onEdit: (schedule: Schedule) => void;
  onCancel: (schedule: Schedule) => void;
  onSendNow: (schedule: Schedule) => void;
}): ReactElement {
  const nextRun = useMemo(
    () => (schedule.next_run_at ? new Date(schedule.next_run_at) : null),
    [schedule.next_run_at],
  );
  useCountdownTick(nextRun);
  const repeats = schedule.recurrence.kind !== "once";
  const condition = schedule.condition;
  const Icon = condition ? SquareTerminal : repeats ? Repeat : CalendarClock;
  const verb = condition ? "Checks" : "Sends";
  const when = [
    nextRun ? formatAbsolute(nextRun) : null,
    repeats ? describeRecurrence(schedule.recurrence) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={STACK_ROW_CLASS}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
          <span className="shrink-0 font-medium text-foreground">
            {nextRun ? `${verb} ${formatRelative(nextRun)}` : verb}
          </span>
          {when && <span className="truncate text-muted-foreground">· {when}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground" title={schedule.prompt}>
          {condition && (
            <>
              If{" "}
              <code className="font-mono text-[11px] text-foreground/80">{condition.command}</code>{" "}
              fails ·{" "}
            </>
          )}
          {scheduleTitle(schedule)}
        </span>
      </span>
      <StackRowActions>
        <StackRowButton
          label="Send now"
          ariaLabel="Send this scheduled message now"
          onClick={() => onSendNow(schedule)}
          disabled={busy}
        >
          <Send className="size-3.5" />
        </StackRowButton>
        <StackRowButton
          label="Edit"
          ariaLabel="Edit this schedule"
          onClick={() => onEdit(schedule)}
          disabled={busy}
        >
          <Pencil className="size-3.5" />
        </StackRowButton>
        <StackRowButton
          label={repeats ? "Delete schedule" : "Cancel"}
          ariaLabel="Cancel this schedule"
          onClick={() => onCancel(schedule)}
          disabled={busy}
          className="hover:text-destructive"
        >
          <X className="size-3.5" />
        </StackRowButton>
      </StackRowActions>
    </li>
  );
}
