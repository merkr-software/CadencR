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
import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { formatAbsolute, weekdayLabels } from "@/lib/schedules/format";
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

const KINDS: { kind: RecurrenceKind; label: (t: UiTranslator) => string }[] = [
  { kind: "once", label: (t) => t("schedules.recurrence.once", "Once") },
  { kind: "interval", label: (t) => t("schedules.recurrence.interval", "Every…") },
  { kind: "daily", label: (t) => t("schedules.recurrence.daily", "Daily") },
  { kind: "weekly", label: (t) => t("schedules.recurrence.weekly", "Weekly") },
  { kind: "monthly", label: (t) => t("schedules.recurrence.monthly", "Monthly") },
];

export interface RecurrenceEditorProps {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
  /** Captured when the dialog opened, so validation doesn't drift as it sits open. */
  now: Date;
  /** The schedule runs a command at these times rather than sending outright,
   *  so the preview names them checks. */
  evaluatesCommand?: boolean;
  /** The schedule runs a custom action: a one-shot "runs", not "sends". */
  runsAction?: boolean;
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
  evaluatesCommand = false,
  runsAction = false,
}: RecurrenceEditorProps): ReactElement {
  const { t } = useUiTranslation();
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
            {label(t)}
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

      <NextRuns
        preview={preview}
        error={error}
        label={previewLabel(value.kind, evaluatesCommand, runsAction, t)}
      />
    </div>
  );
});

interface FieldsProps {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
}

function IntervalFields({ value, onChange }: FieldsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">
          {t("schedules.recurrence.intervalLabel", "Interval")}
        </span>
        <Input
          type="number"
          min={1}
          step={1}
          value={String(value.intervalValue)}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange({ ...value, intervalValue: parsed });
          }}
          className="h-8 w-20 text-sm no-spinner"
        />
      </label>
      <Select
        value={value.intervalUnit}
        onValueChange={(unit) => onChange({ ...value, intervalUnit: unit as IntervalUnit })}
      >
        <SelectTrigger
          size="sm"
          className="h-8 w-[7rem] text-sm"
          aria-label={t("schedules.recurrence.unit", "Interval unit")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="minutes">{t("schedules.recurrence.minutes", "minutes")}</SelectItem>
          <SelectItem value="hours">{t("schedules.recurrence.hours", "hours")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function MonthlyFields({ value, onChange }: FieldsProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">
          {t("schedules.recurrence.dayOfMonth", "Day of month")}
        </span>
        <Input
          type="number"
          min={1}
          max={31}
          step={1}
          value={String(value.dayOfMonth)}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange({ ...value, dayOfMonth: parsed });
          }}
          className="h-8 w-20 text-sm no-spinner"
        />
      </label>
      <span className="text-muted-foreground">
        {t("schedules.recurrence.shortMonthHelp", "Shorter months use their last day.")}
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
  const { t, i18n } = useUiTranslation();
  const labels = weekdayLabels("narrow", i18n.language);
  const names = weekdayLabels("long", i18n.language);
  return (
    <div
      className="flex gap-1"
      role="group"
      aria-label={t("schedules.recurrence.days", "Days of the week")}
    >
      {labels.map((label, index) => {
        const day = index + 1;
        const selected = weekdays.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={selected}
            aria-label={names[index]}
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
  const { t, i18n } = useUiTranslation();
  const { hours, minutes } = parseTimeOfDay(value);
  const asDate = useMemo(() => {
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
  }, [hours, minutes]);

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground">{t("schedules.recurrence.at", "At")}</span>
      <Input
        type="time"
        lang={i18n.language}
        aria-label={t("schedules.recurrence.timeOfDay", "Time of day")}
        value={value}
        onChange={(event) => onChange(event.target.value || toTimeOfDay(asDate))}
        className="h-8 w-32 text-sm"
      />
    </div>
  );
}

function previewLabel(
  kind: RecurrenceKind,
  evaluatesCommand: boolean,
  runsAction: boolean,
  t: UiTranslator,
): string {
  if (kind === "once") {
    if (evaluatesCommand) return t("schedules.preview.checks", "Checks");
    return runsAction ? t("schedules.preview.runs", "Runs") : t("schedules.preview.sends", "Sends");
  }
  return evaluatesCommand
    ? t("schedules.preview.nextChecks", "Next checks")
    : t("schedules.preview.nextRuns", "Next runs");
}

function NextRuns({
  preview,
  error,
  label,
}: {
  preview: Date[];
  error: string | null;
  label: string;
}): ReactElement {
  const { t, i18n } = useUiTranslation();
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!preview.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("schedules.preview.empty", "No upcoming runs.")}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      <UiTrans
        i18nKey="schedules.preview.summary"
        defaults="<label>{{label}}:</label> {{dates}} <zone>({{timezone}})</zone>"
        values={{
          label,
          dates: preview.map((date) => formatAbsolute(date, i18n.language)).join(" · "),
          timezone: localTimeZone(),
        }}
        components={{
          label: <span className="text-foreground/80" />,
          zone: <span className="opacity-70" />,
        }}
      />
    </p>
  );
}
