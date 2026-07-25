import { memo, useMemo, type ReactElement } from "react";
import type { RecurrenceKind } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatAbsolute } from "@/lib/schedules/format";
import {
  draftError,
  localTimeZone,
  nextOccurrences,
  parseTimeOfDay,
  toTimeOfDay,
  type IntervalUnit,
  type RecurrenceDraft,
} from "@/lib/schedules/recurrence";
import { cn } from "@/lib/utils";
import { DateTimePicker } from "./DateTimePicker";

const KINDS: { kind: RecurrenceKind; label: string }[] = [
  { kind: "once", label: "Once" },
  { kind: "interval", label: "Every…" },
  { kind: "daily", label: "Daily" },
  { kind: "weekly", label: "Weekly" },
  { kind: "monthly", label: "Monthly" },
];

const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: "M" },
  { day: 2, label: "T" },
  { day: 3, label: "W" },
  { day: 4, label: "T" },
  { day: 5, label: "F" },
  { day: 6, label: "S" },
  { day: 7, label: "S" },
];

export interface RecurrenceEditorProps {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
  /** Captured when the dialog opened, so validation doesn't drift as it sits open. */
  now: Date;
}

/**
 * Picks *when* a schedule fires.
 *
 * Structured rather than a cron field: the five kinds cover what people
 * actually schedule, and each one renders as a sentence the user can check. The
 * live "next runs" preview is the safety net — it is how you catch that
 * "monthly on the 31st" means the 28th in February before you save it.
 */
export const RecurrenceEditor = memo(function RecurrenceEditor({
  value,
  onChange,
  now,
}: RecurrenceEditorProps): ReactElement {
  const error = draftError(value, now);
  const preview = useMemo(() => nextOccurrences(value, 3, now), [value, now]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map(({ kind, label }) => (
          <Button
            key={kind}
            type="button"
            variant={value.kind === kind ? "default" : "outline"}
            size="sm"
            aria-pressed={value.kind === kind}
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => onChange({ ...value, kind })}
          >
            {label}
          </Button>
        ))}
      </div>

      {value.kind === "once" && (
        <DateTimePicker
          value={value.runAt}
          onChange={(runAt) => onChange({ ...value, runAt })}
          min={now}
          invalid={!!error}
        />
      )}

      {value.kind === "interval" && <IntervalFields value={value} onChange={onChange} />}

      {value.kind === "weekly" && (
        <WeekdayPicker
          weekdays={value.weekdays}
          onToggle={(day) =>
            onChange({
              ...value,
              weekdays: value.weekdays.includes(day)
                ? value.weekdays.filter((existing) => existing !== day)
                : [...value.weekdays, day],
            })
          }
        />
      )}

      {value.kind === "monthly" && <MonthlyFields value={value} onChange={onChange} />}

      {(value.kind === "daily" || value.kind === "weekly" || value.kind === "monthly") && (
        <TimeOfDayPicker
          value={value.timeOfDay}
          onChange={(timeOfDay) => onChange({ ...value, timeOfDay })}
        />
      )}

      <NextRuns preview={preview} error={error} repeating={value.kind !== "once"} />
    </div>
  );
});

interface FieldsProps {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
}

/** "Every N minutes/hours". */
function IntervalFields({ value, onChange }: FieldsProps): ReactElement {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Every</span>
      <Input
        type="number"
        min={1}
        step={1}
        aria-label="Interval"
        value={String(value.intervalValue)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange({ ...value, intervalValue: parsed });
        }}
        className="h-8 w-20 text-sm no-spinner"
      />
      <Select
        value={value.intervalUnit}
        onValueChange={(unit) => onChange({ ...value, intervalUnit: unit as IntervalUnit })}
      >
        <SelectTrigger size="sm" className="h-8 w-[7rem] text-sm" aria-label="Interval unit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minutes">minutes</SelectItem>
          <SelectItem value="hours">hours</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** "On day N of each month". */
function MonthlyFields({ value, onChange }: FieldsProps): ReactElement {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">On day</span>
      <Input
        type="number"
        min={1}
        max={31}
        step={1}
        aria-label="Day of month"
        value={String(value.dayOfMonth)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange({ ...value, dayOfMonth: parsed });
        }}
        className="h-8 w-20 text-sm no-spinner"
      />
      <span className="text-muted-foreground">
        of each month — shorter months use their last day
      </span>
    </div>
  );
}

function WeekdayPicker({
  weekdays,
  onToggle,
}: {
  weekdays: number[];
  onToggle: (day: number) => void;
}): ReactElement {
  return (
    <div className="flex gap-1" role="group" aria-label="Days of the week">
      {WEEKDAYS.map(({ day, label }, index) => {
        const selected = weekdays.includes(day);
        return (
          <button
            // Two days share the label "T" (and two share "S"), so the index
            // disambiguates the key and the accessible name carries the rest.
            key={day}
            type="button"
            aria-pressed={selected}
            aria-label={
              ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][index]
            }
            onClick={() => onToggle(day)}
            className={cn(
              "size-8 rounded-full border text-xs font-medium transition-colors",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function TimeOfDayPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): ReactElement {
  const { hours, minutes } = parseTimeOfDay(value);
  const asDate = useMemo(() => {
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
  }, [hours, minutes]);

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground">At</span>
      <Input
        type="time"
        aria-label="Time of day"
        value={value}
        onChange={(event) => onChange(event.target.value || toTimeOfDay(asDate))}
        className="h-8 w-32 text-sm"
      />
    </div>
  );
}

function NextRuns({
  preview,
  error,
  repeating,
}: {
  preview: Date[];
  error: string | null;
  repeating: boolean;
}): ReactElement {
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!preview.length) return <p className="text-xs text-muted-foreground">No upcoming runs.</p>;
  return (
    <p className="text-xs text-muted-foreground">
      <span className="text-foreground/80">{repeating ? "Next runs" : "Sends"}:</span>{" "}
      {preview.map((date) => formatAbsolute(date)).join(" · ")}
      <span className="opacity-70"> ({localTimeZone()})</span>
    </p>
  );
}
