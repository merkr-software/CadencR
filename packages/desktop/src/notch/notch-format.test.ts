import { formatClock } from "@/lib/format-clock";
import { translateUi } from "@/lib/i18n/ui";
import { describe, expect, it } from "vitest";
import { formatAge, formatSnoozeDuration } from "./notch-format";

describe("formatAge", () => {
  it("compacts ages", () => {
    expect(formatAge(20_000, translateUi, "en")).toBe("now");
    expect(formatAge(4 * 60_000, translateUi, "en")).toBe("4m");
    expect(formatAge(2 * 3_600_000, translateUi, "en")).toBe("2h");
    expect(formatAge(3 * 86_400_000, translateUi, "en")).toBe("3d");
  });
});

it("uses the interface locale's wall-clock convention", () => {
  const time = new Date(2026, 10, 25, 13, 5).getTime();
  expect(formatClock(time, "en-US")).toBe("1:05 PM");
  expect(formatClock(time, "fr-FR")).toBe("13:05");
});

it("keeps snooze durations compact", () => {
  expect(formatSnoozeDuration(5, translateUi, "en")).toBe("5m");
  expect(formatSnoozeDuration(60, translateUi, "en")).toBe("1h");
  expect(formatSnoozeDuration(90, translateUi, "en")).toBe("1h30");
});
