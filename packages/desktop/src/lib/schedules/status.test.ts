import { describe, expect, it } from "vitest";

import type { Schedule } from "@/api/generated";
import { isActive, nextRunAcross, scheduleState } from "./status";

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
