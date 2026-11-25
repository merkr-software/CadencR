import { afterEach, describe, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
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
  uiI18n.removeResourceBundle("fr", "ui");
});

describe("schedule formatting", () => {
  it.each([
    [0, "Every 0 hours"],
    [5, "Every 0 minutes"],
    [60, "Every minute"],
    [120, "Every 2 minutes"],
    [3600, "Every hour"],
    [7200, "Every 2 hours"],
  ])("keeps the English interval fallback for %s seconds in French", async (seconds, expected) => {
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
    expect(formatAbsolute(new Date(2027, 0, 4, 9, 30))).toBe("Today at 9 h 30");
    expect(formatAbsolute(new Date(2027, 0, 5, 9, 30))).toBe("Tomorrow at 9 h 30");
    expect(formatAbsolute(new Date(2027, 0, 6, 9, 30))).toBe("mer. 6 janv. at 9 h 30");
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
});
