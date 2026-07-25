import { memo, useMemo, useState, type ReactElement } from "react";
import { CalendarClock, ChevronDown, Loader2, Pencil, Repeat, Send, X } from "lucide-react";
import type { Schedule } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
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
 * What this conversation has queued, shown above the composer.
 *
 * A conversation can now hold several schedules, but the composer is not the
 * place to manage a list: it shows the next one in full and collapses the rest
 * behind a count, so the banner stays one line tall in the common case.
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
    <div className="flex flex-col gap-1 px-3 pt-2">
      {visible.map((schedule) => (
        <ScheduleLine
          key={schedule.id}
          schedule={schedule}
          busy={busy}
          onEdit={onEdit}
          onCancel={onCancel}
          onSendNow={onSendNow}
        />
      ))}
      {schedules.length > 1 && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="self-start px-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("mr-1 inline size-3 transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Show less" : `${schedules.length - 1} more scheduled`}
        </button>
      )}
    </div>
  );
});

function ScheduleLine({
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
  const Icon = repeats ? Repeat : CalendarClock;

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
      <Icon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-xs">
          <span className="font-medium text-foreground">
            {nextRun ? `Scheduled ${formatRelative(nextRun)}` : "Scheduled"}
          </span>
          <span className="truncate text-muted-foreground">
            · {nextRun ? formatAbsolute(nextRun) : ""}
            {repeats ? ` · ${describeRecurrence(schedule.recurrence)}` : ""}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={schedule.prompt}>
          {scheduleTitle(schedule)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {busy && <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" />}
        <ShortcutTooltip label="Edit">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onEdit(schedule)}
            disabled={busy}
            aria-label="Edit this schedule"
          >
            <Pencil className="size-3.5" />
          </Button>
        </ShortcutTooltip>
        <ShortcutTooltip label="Send now">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onSendNow(schedule)}
            disabled={busy}
            aria-label="Send this scheduled message now"
          >
            <Send className="size-3.5" />
          </Button>
        </ShortcutTooltip>
        <ShortcutTooltip label={repeats ? "Delete schedule" : "Cancel"}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={() => onCancel(schedule)}
            disabled={busy}
            aria-label="Cancel this schedule"
          >
            <X className="size-3.5" />
          </Button>
        </ShortcutTooltip>
      </div>
    </div>
  );
}
