import { afterEach, describe, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import frFR from "@/lib/i18n/catalogs/fr-FR.json";
import {
  describeRecurrence,
  formatAbsolute,
  formatRelative,
  formatTimeOfDay,
  weekdayLabels,
} from "./format";
import { draftToInput, emptyDraft, nextOccurrences } from "./recurrence";

afterEach(async () => {
  vi.useRealTimers();
  await uiI18n.changeLanguage("en");
  if (uiI18n.hasResourceBundle("fr", "ui")) {
    uiI18n.removeResourceBundle("fr", "ui");
    await uiI18n.loadNamespaces("ui");
  }
});

describe("schedule formatting", () => {
  const { recurrence, date } = frFR.ui.schedules;

  it.each([
    [0, recurrence.everyHour_zero],
    [5, recurrence.everyMinute_zero],
    [60, recurrence.everyMinute_one],
    [120, recurrence.everyMinute_other.replace("{{count, number}}", "2")],
    [3600, recurrence.everyHour_one],
    [7200, recurrence.everyHour_other.replace("{{count, number}}", "2")],
  ])("uses the French interval form for %s seconds", async (seconds, expected) => {
    await uiI18n.changeLanguage("fr-CA");
    expect(
      describeRecurrence({ kind: "interval", timezone: "UTC", interval_seconds: seconds }),
    ).toBe(expected);
  });

  it("uses the locale for dates, wall times, and ISO weekday labels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 4, 9));
    await uiI18n.changeLanguage("fr-CA");
    expect(formatTimeOfDay("09:30")).toBe("9 h 30");
    expect(formatTimeOfDay("09:30", "fr")).toBe("9:30");
    expect(formatAbsolute(new Date(2027, 0, 4, 9, 30))).toBe(
      date.todayAt.replace("{{time}}", "9 h 30"),
    );
    expect(formatAbsolute(new Date(2027, 0, 5, 9, 30))).toBe(
      date.tomorrowAt.replace("{{time}}", "9 h 30"),
    );
    expect(formatAbsolute(new Date(2027, 0, 6, 9, 30))).toBe(
      date.dayAt.replace("{{day}}", "mer. 6 janv.").replace("{{time}}", "9 h 30"),
    );
    expect(formatRelative(new Date(2027, 0, 4, 11))).toBe("dans 2 heures");
    expect(weekdayLabels("long", "fr-CA")[0]).toBe("lundi");
    expect(weekdayLabels("long", "fr-CA")[6]).toBe("dimanche");
  });

  it("sorts ISO days for display without changing the stored weekday order or clock value", async () => {
    const now = new Date(2027, 0, 1, 9);
    const draft = { ...emptyDraft(now), kind: "weekly" as const, weekdays: [7, 1, 3] };
    const rule = { ...draftToInput(draft), weekdays: draft.weekdays, timezone: "UTC" };
    expect(describeRecurrence(rule)).toBe("Every Mon, Wed, Sun at 9:00 AM");

    uiI18n.addResourceBundle("fr", "ui", {
      schedules: { recurrence: { weeklyAt: "{{days}} à {{time}}" } },
    });
    await uiI18n.changeLanguage("fr-CA");
    expect(describeRecurrence(rule)).toBe("lun., mer. et dim. à 9 h 00");
    expect(draft.weekdays).toEqual([7, 1, 3]);
    expect(draftToInput(draft)).toMatchObject({ weekdays: [1, 3, 7], time_of_day: "09:00" });
  });

  it.each([
    [[1, 2, 3, 4, 5], "On weekdays at 9:00 AM"],
    [[6, 7], "On weekends at 9:00 AM"],
    [[1, 2, 3, 4, 5, 6, 7], "Every day at 9:00 AM"],
  ])("recognizes common weekly patterns %j", (weekdays, expected) => {
    expect(describeRecurrence({ kind: "weekly", timezone: "UTC", weekdays })).toBe(expected);
  });

  it("allows a translated monthly sentence to use the day number and preserves preview clamping", async () => {
    const now = new Date(2027, 1, 1, 9);
    const draft = { ...emptyDraft(now), kind: "monthly" as const, dayOfMonth: 31 };
    const rule = { ...draftToInput(draft), timezone: "UTC" };
    expect(describeRecurrence(rule)).toBe("Monthly on the 31st at 9:00 AM");

    uiI18n.addResourceBundle("fr", "ui", {
      schedules: { recurrence: { monthlyAt: "Le {{day}} du mois à {{time}}" } },
    });
    await uiI18n.changeLanguage("fr-CA");
    expect(describeRecurrence(rule)).toBe("Le 31 du mois à 9 h 00");
    expect(nextOccurrences(draft, 2, now)).toEqual([
      new Date(2027, 1, 28, 9),
      new Date(2027, 2, 31, 9),
    ]);
  });

  it.each([
    ["en-US", 31, "31st"],
    ["fr-FR", 1, "1er"],
    ["fr-CA", 31, "31"],
    ["de-DE", 31, "31."],
    ["ja-JP", 31, "31日"],
    ["es-MX", 31, "31"],
    ["pt-PT", 31, "31"],
  ])("uses the %s ordinal for monthly day %i", async (locale, day, display) => {
    await uiI18n.changeLanguage(locale);
    const rule = { kind: "monthly", day_of_month: day, timezone: "UTC" } as const;
    const time = formatTimeOfDay("09:00", locale);
    const template: unknown = uiI18n.getResource(
      uiI18n.resolvedLanguage ?? locale,
      "ui",
      "schedules.recurrence.monthlyAt",
    );
    if (typeof template !== "string") throw new Error(`Missing monthly recurrence for ${locale}`);
    expect(describeRecurrence(rule)).toBe(
      template.replace("{{dayOrdinal}}", display).replace("{{time}}", time),
    );
  });
});
