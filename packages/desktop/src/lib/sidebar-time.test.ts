import { describe, expect, it } from "vitest";
import { formatSidebarAbsoluteTime, formatSidebarRelativeTime } from "./sidebar-time";

const NOW = new Date("2026-07-10T12:00:00").getTime();
const ago = (ms: number) => new Date(NOW - ms);
const MINUTE = 60_000;

describe("formatSidebarRelativeTime", () => {
  it.each([
    [30_000, "now"],
    [5 * MINUTE, "5m"],
    [3 * 60 * MINUTE, "3h"],
    [2 * 24 * 60 * MINUTE, "2d"],
    [15 * 24 * 60 * MINUTE, "2w"],
  ])("formats %d ms ago as %s", (elapsed, label) => {
    expect(formatSidebarRelativeTime(ago(elapsed), NOW)).toBe(label);
  });

  it("counts months then years instead of printing a wide date", () => {
    expect(formatSidebarRelativeTime(new Date("2026-05-02T09:00:00"), NOW)).toBe("2mo");
    expect(formatSidebarRelativeTime(new Date("2026-06-03T09:00:00"), NOW)).toBe("1mo");
    expect(formatSidebarRelativeTime(new Date("2024-12-24T09:00:00"), NOW)).toBe("1y");
  });

  it("never shows a negative time for a clock running ahead", () => {
    expect(formatSidebarRelativeTime(new Date(NOW + 5 * MINUTE), NOW)).toBe("now");
  });
});

describe("formatSidebarAbsoluteTime", () => {
  it("shows the clock time today and the date otherwise", () => {
    expect(formatSidebarAbsoluteTime(ago(2 * 60 * MINUTE), NOW)).toMatch(/10:00/);
    expect(formatSidebarAbsoluteTime(new Date("2026-07-01T09:00:00"), NOW)).toBe("Jul 1");
    expect(formatSidebarAbsoluteTime(new Date("2025-12-24T09:00:00"), NOW)).toBe("Dec 24, 2025");
  });
});
