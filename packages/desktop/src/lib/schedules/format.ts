/**
 * Human-readable renderings of a schedule.
 *
 * A schedule is only useful if the user can read its rule at a glance — "Every
 * weekday at 9:00 AM" rather than a row of fields to reassemble mentally. All
 * absolute times render in the viewer's local timezone; the wire is UTC.
 */
import { isToday, isTomorrow } from "date-fns";
import type { Recurrence, Schedule } from "@/api/generated";
import { formatRelativeDistance } from "@/lib/date-utils";
import { translateUi, uiI18n } from "@/lib/i18n/ui";
import { parseTimeOfDay } from "./recurrence";

const ISO_WEEK = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 7];
const ISO_WEEK_DATES = ISO_WEEK.map((day) => Date.UTC(2024, 0, day));

type WeekdayWidth = "narrow" | "short" | "long";

function makeScheduleFormats(language: string) {
  return {
    clock: new Intl.DateTimeFormat(language, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }),
    date: new Intl.DateTimeFormat(language, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
    list: new Intl.ListFormat(language, { type: "unit", style: "short" }),
    weekdays: new Map<WeekdayWidth, readonly string[]>(),
  };
}

const scheduleFormats = new Map<string, ReturnType<typeof makeScheduleFormats>>();

function formatsFor(language: string) {
  const cached = scheduleFormats.get(language);
  if (cached) return cached;
  const formats = makeScheduleFormats(language);
  scheduleFormats.set(language, formats);
  return formats;
}

/** ISO weekday labels use fixed UTC dates so their names never shift with the local timezone. */
export function weekdayLabels(weekday: WeekdayWidth, language: string): readonly string[] {
  const { weekdays } = formatsFor(language);
  const cached = weekdays.get(weekday);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(language, { weekday, timeZone: "UTC" });
  const labels = ISO_WEEK_DATES.map((day) => formatter.format(day));
  weekdays.set(weekday, labels);
  return labels;
}

/** `HH:MM` rendered in the viewer's locale, e.g. `9:00 AM`. */
export function formatTimeOfDay(timeOfDay: string, language = uiI18n.language): string {
  const { hours, minutes } = parseTimeOfDay(timeOfDay);
  return formatsFor(language).clock.format(Date.UTC(2024, 0, 1, hours, minutes));
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((day, index) => day === b[index]);
}

function describeWeekly(weekdays: number[], time: string, language: string): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sameDays(sorted, ISO_WEEK)) {
    return translateUi("schedules.recurrence.everyDayAt", "Every day at {{time}}", { time });
  }
  if (sameDays(sorted, WEEKDAYS)) {
    return translateUi("schedules.recurrence.weekdaysAt", "On weekdays at {{time}}", { time });
  }
  if (sameDays(sorted, WEEKEND)) {
    return translateUi("schedules.recurrence.weekendsAt", "On weekends at {{time}}", { time });
  }
  const labels = weekdayLabels("short", language);
  const days = formatsFor(language).list.format(sorted.map((day) => labels[day - 1] ?? ""));
  return translateUi("schedules.recurrence.weeklyAt", "Every {{days}} at {{time}}", { days, time });
}

function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) {
    return translateUi("schedules.recurrence.everyHour", {
      count: seconds / 3600,
      defaultValue_zero: "Every 0 hours",
      defaultValue_one: "Every hour",
      defaultValue_other: "Every {{count, number}} hours",
    });
  }
  return translateUi("schedules.recurrence.everyMinute", {
    count: Math.round(seconds / 60),
    defaultValue_zero: "Every 0 minutes",
    defaultValue_one: "Every minute",
    defaultValue_other: "Every {{count, number}} minutes",
  });
}

function englishOrdinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

/** The rule as a sentence, e.g. `On weekdays at 9:00 AM`. */
export function describeRecurrence(recurrence: Recurrence, language = uiI18n.language): string {
  switch (recurrence.kind) {
    case "once":
      return translateUi("schedules.recurrence.once", "Once");
    case "interval":
      return describeInterval(recurrence.interval_seconds ?? 60);
    case "daily":
      return translateUi("schedules.recurrence.everyDayAt", "Every day at {{time}}", {
        time: formatTimeOfDay(recurrence.time_of_day ?? "09:00", language),
      });
    case "weekly":
      return describeWeekly(
        recurrence.weekdays ?? [],
        formatTimeOfDay(recurrence.time_of_day ?? "09:00", language),
        language,
      );
    case "monthly": {
      const day = recurrence.day_of_month ?? 1;
      return translateUi(
        "schedules.recurrence.monthlyAt",
        "Monthly on the {{dayOrdinal}} at {{time}}",
        {
          day,
          dayOrdinal: englishOrdinal(day),
          time: formatTimeOfDay(recurrence.time_of_day ?? "09:00", language),
        },
      );
    }
    default:
      return translateUi("schedules.recurrence.custom", "Custom");
  }
}

/** A short absolute label in local time, e.g. `Today at 3:00 PM`. */
export function formatAbsolute(date: Date, language = uiI18n.language): string {
  // Read the current local calendar fields so cached formatters survive a system timezone change.
  const local = new Date(0);
  local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  local.setUTCHours(date.getHours(), date.getMinutes());
  const formats = formatsFor(language);
  const time = formats.clock.format(local);
  if (isToday(date)) return translateUi("schedules.date.todayAt", "Today at {{time}}", { time });
  if (isTomorrow(date)) {
    return translateUi("schedules.date.tomorrowAt", "Tomorrow at {{time}}", { time });
  }
  const day = formats.date.format(local);
  return translateUi("schedules.date.dayAt", "{{day}} at {{time}}", { day, time });
}

/** A relative label, e.g. `in 2 hours`. */
export function formatRelative(date: Date, language = uiI18n.language): string {
  return formatRelativeDistance(date, language);
}

/** Whether the schedule runs a custom action rather than sending a prompt. */
export function isActionSchedule(schedule: Schedule): boolean {
  return schedule.target.kind === "custom_action";
}

function actionName(schedule: Schedule): string {
  return (
    schedule.context.action_name ?? translateUi("schedules.target.customAction", "a custom action")
  );
}

/** What the schedule targets, e.g. `New conversation in cadencr`, or
 *  `Runs in Fix login` for a custom action (whose name is the title). */
export function describeTarget(schedule: Schedule): string {
  if (isActionSchedule(schedule)) {
    return schedule.context.feature_title == null
      ? translateUi("schedules.target.runsInConversation", "Runs in a conversation")
      : translateUi("schedules.target.runsInFeature", "Runs in {{title}}", {
          title: schedule.context.feature_title,
        });
  }
  if (schedule.target.kind === "new_conversation") {
    const project = schedule.context.project_name;
    return project
      ? translateUi("schedules.target.newInProject", "New conversation in {{project}}", { project })
      : translateUi("schedules.target.newConversation", "New conversation");
  }
  return (
    schedule.context.feature_title ?? translateUi("schedules.target.conversation", "A conversation")
  );
}

/** First line of the prompt, clipped — what the run will actually send, which
 *  is how a schedule is recognized in a list of them. An action schedule sends
 *  nothing, so it is recognized by the action it runs. */
export function schedulePromptPreview(schedule: Schedule, maxLength = 120): string {
  if (isActionSchedule(schedule)) {
    return schedule.context.action_name == null
      ? translateUi("schedules.target.runsCustomAction", "Runs a custom action")
      : translateUi("schedules.target.runsAction", "Runs {{action}}", {
          action: schedule.context.action_name,
        });
  }
  const firstLine = schedule.prompt.trim().split("\n")[0].trim();
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
}

/** The label a schedule is listed under. Falls back to its prompt's first line
 *  (or the action it runs) so an unnamed schedule is still identifiable at a
 *  glance. */
export function scheduleTitle(schedule: Schedule): string {
  const name = schedule.name?.trim();
  if (name) return name;
  // The action's own name: actions are usually named for what they do
  // ("Run tests"), so a "Run" prefix would read "Run Run tests".
  if (isActionSchedule(schedule)) return actionName(schedule);
  return (
    schedulePromptPreview(schedule, 80) ||
    translateUi("schedules.title.untitled", "Untitled schedule")
  );
}

/**
 * Delay (ms) until the next countdown re-render, or `null` to stop. Tightens to
 * 1s inside the final minute and relaxes to 30s further out; stops once the
 * target is ~1s past due.
 */
export function nextCountdownDelay(msUntil: number): number | null {
  if (msUntil <= -1_000) return null;
  return msUntil <= 60_000 ? 1_000 : 30_000;
}
