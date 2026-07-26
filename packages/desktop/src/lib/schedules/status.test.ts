import { describe, expect, it } from "vitest";

import type { Schedule } from "@/api/generated";
import { isActive, isDue, nextRunAcross, scheduleState } from "./status";

const NOW = Date.parse("2026-07-26T12:00:00Z");

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 1,
    name: "Nightly recap",
    prompt: "Recap yesterday",
    enabled: true,
    completed: false,
    next_run_at: "2026-07-27T09:00:00Z",
    ...overrides,
  } as Schedule;
}

describe("scheduleState", () => {
  it("calls a paused schedule paused even when its last run failed", () => {
    expect(
      scheduleState(
        schedule({ enabled: false, last_run: { status: "failed" } } as Partial<Schedule>),
      ),
    ).toBe("paused");
  });

  it("calls a finished one-off done even though it is still enabled", () => {
    expect(scheduleState(schedule({ completed: true }))).toBe("completed");
  });
});

describe("isDue", () => {
  it("is true for an armed schedule whose run time has passed", () => {
    expect(isDue(schedule({ next_run_at: "2026-07-26T09:00:00Z" }), NOW)).toBe(true);
  });

  it("is false while the run is still ahead", () => {
    expect(isDue(schedule(), NOW)).toBe(false);
  });

  // Regression: pausing deliberately keeps `next_run_at` so the rule reads the
  // same when it resumes, which leaves every paused schedule permanently in the
  // past. A timestamp-only check latches on forever — and the WS handler that
  // uses this then invalidates every schedule list variant on every message.
  it("is false for a paused schedule stuck in the past", () => {
    expect(isDue(schedule({ enabled: false, next_run_at: "2020-01-01T00:00:00Z" }), NOW)).toBe(
      false,
    );
  });

  it("is false for a completed schedule stuck in the past", () => {
    expect(isDue(schedule({ completed: true, next_run_at: "2020-01-01T00:00:00Z" }), NOW)).toBe(
      false,
    );
  });

  it("is false when the timestamp is missing or unparseable", () => {
    expect(isDue(schedule({ next_run_at: null }), NOW)).toBe(false);
    expect(isDue(schedule({ next_run_at: "not a date" }), NOW)).toBe(false);
  });
});

describe("isActive / nextRunAcross", () => {
  it("counts only schedules that will fire again", () => {
    const rows = [
      schedule({ id: 1 }),
      schedule({ id: 2, enabled: false }),
      schedule({ id: 3, completed: true }),
      schedule({ id: 4, next_run_at: null }),
    ];
    expect(rows.filter(isActive).map((row) => row.id)).toEqual([1]);
  });

  it("reports the soonest armed run, ignoring paused rows that sort earlier", () => {
    const soonest = nextRunAcross([
      schedule({ id: 1, next_run_at: "2026-07-28T09:00:00Z" }),
      schedule({ id: 2, next_run_at: "2026-07-27T09:00:00Z" }),
      schedule({ id: 3, enabled: false, next_run_at: "2020-01-01T00:00:00Z" }),
    ]);
    expect(soonest?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
  });
});
