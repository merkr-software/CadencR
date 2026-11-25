import { useCallback, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { startOfDay } from "date-fns";
import { enCA } from "react-day-picker/locale/en-CA";
import { enGB } from "react-day-picker/locale/en-GB";
import { frCA } from "react-day-picker/locale/fr-CA";
import { fr } from "react-day-picker/locale/fr";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function calendarLocale(language: string) {
  switch (language) {
    case "en-CA":
      return enCA;
    case "en-GB":
      return enGB;
    case "fr-CA":
      return frCA;
    default:
      return language.startsWith("fr") ? fr : undefined;
  }
}

export interface DateTimePickerProps {
  value: Date;
  onChange: (next: Date) => void;
  /** Earliest selectable day; earlier days are disabled in the calendar. */
  min?: Date;
  /** Render the date trigger with an error border (e.g. the picked time is past). */
  invalid?: boolean;
}

/**
 * A shadcn date + time picker: a calendar popover for the day plus hour/minute
 * selects, all themed to match the app. Replaces the native `datetime-local`
 * input. Operates entirely on local-time `Date`s; the caller converts to UTC.
 */
export function DateTimePicker({ value, onChange, min, invalid }: DateTimePickerProps) {
  const { t, i18n } = useUiTranslation();
  const language = i18n.language;
  const [open, setOpen] = useState(false);
  const label = new Intl.DateTimeFormat(language, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);

  const setDay = useCallback(
    (day?: Date) => {
      if (!day) return;
      const next = new Date(value);
      next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
      onChange(next);
      setOpen(false);
    },
    [onChange, value],
  );

  const setHour = useCallback(
    (hour: string) => {
      const next = new Date(value);
      next.setHours(Number(hour));
      onChange(next);
    },
    [onChange, value],
  );

  const setMinute = useCallback(
    (minute: string) => {
      const next = new Date(value);
      next.setMinutes(Number(minute));
      onChange(next);
    },
    [onChange, value],
  );

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "flex-1 justify-start gap-2 font-normal",
              invalid && "border-destructive",
            )}
          >
            <CalendarIcon className="size-4 text-muted-foreground" />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            locale={calendarLocale(language)}
            selected={value}
            onSelect={setDay}
            defaultMonth={value}
            disabled={min ? { before: startOfDay(min) } : undefined}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      <div className="flex items-center gap-1">
        <Select value={String(value.getHours()).padStart(2, "0")} onValueChange={setHour}>
          <SelectTrigger className="w-[4.25rem]" aria-label={t("schedules.date.hour", "Hour")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-60">
            {HOURS.map((h) => (
              <SelectItem key={h} value={h}>
                {h}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">:</span>
        <Select value={String(value.getMinutes()).padStart(2, "0")} onValueChange={setMinute}>
          <SelectTrigger className="w-[4.25rem]" aria-label={t("schedules.date.minute", "Minute")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-60">
            {MINUTES.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
