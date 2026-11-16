import { describe, expect, it } from "vitest";

import type { CustomAction, CustomActionRun } from "@/api/generated";
import { formatDuration, runOutcomeText } from "./run-history";
import {
  aggregateRunState,
  parseRunTimestamp,
  RUN_STATE_DOT_CLASS,
  runStateOf,
  runStateText,
} from "./run-state";

function action(overrides: Partial<CustomAction>): CustomAction {
  return {
    id: 1,
    name: "Run tests",
    command: "pnpm test",
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    position: 0,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: [],
    last_run: null,
    ...overrides,
  };
}

const finished = (exit_code: number) => ({
  run_id: 3,
  started_at: "2026-01-01 00:00:00",
  ended_at: "2026-01-01 00:00:04",
  exit_code,
});

describe("run state", () => {
  it("reads running, passed, failed and never-run summaries", () => {
    expect(runStateOf(null)).toBe("idle");
    expect(runStateOf({ ended_at: null, exit_code: null })).toBe("running");
    expect(runStateOf(finished(0))).toBe("succeeded");
    expect(runStateOf(finished(2))).toBe("failed");
    expect(runStateOf(finished(130))).toBe("stopped");
  });

  it("only marks running and failed with a dot", () => {
    expect(RUN_STATE_DOT_CLASS.idle).toBeNull();
    expect(RUN_STATE_DOT_CLASS.succeeded).toBeNull();
    expect(RUN_STATE_DOT_CLASS.running).toContain("--acc-orange");
    expect(RUN_STATE_DOT_CLASS.failed).toContain("--acc-red");
  });

  it("says what happened in words", () => {
    expect(runStateText(null)).toBe("Never run");
    expect(runStateText({ ended_at: null, exit_code: null })).toBe("Running…");
    expect(runStateText(finished(0))).toMatch(/^Passed /);
    expect(runStateText(finished(1))).toMatch(/^Failed \(exit 1\) /);
    expect(runStateText(finished(130))).toMatch(/^Stopped /);
  });

  it("parses the service's SQLite UTC timestamps", () => {
    expect(parseRunTimestamp("2026-01-01 10:00:00").toISOString()).toBe("2026-01-01T10:00:00.000Z");
    expect(parseRunTimestamp("2026-01-01T10:00:00Z").toISOString()).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("aggregates the most urgent background state, ignoring terminal actions", () => {
    const running = action({ last_run: { ...finished(0), ended_at: null, exit_code: null } });
    const failed = action({ last_run: finished(1) });
    const passed = action({ last_run: finished(0) });
    const terminal = action({ run_in_terminal: true, last_run: finished(1) });
    expect(aggregateRunState([passed, failed, running])).toBe("running");
    expect(aggregateRunState([passed, failed])).toBe("failed");
    expect(aggregateRunState([passed, terminal])).toBe("succeeded");
    expect(aggregateRunState([])).toBe("idle");
  });
});

describe("run history", () => {
  const run = (overrides: Partial<CustomActionRun>): CustomActionRun => ({
    id: 9,
    action_id: 1,
    feature_id: 2,
    stdout: "",
    stderr: "",
    started_at: "2026-01-01 00:00:00",
    ended_at: "2026-01-01 00:02:05",
    exit_code: 0,
    triggered_by: "manual",
    ...overrides,
  });

  it("formats durations compactly", () => {
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });

  it("describes how a run ended", () => {
    expect(runOutcomeText(run({}))).toBe("Passed in 2m 05s");
    expect(runOutcomeText(run({ exit_code: 3 }))).toBe("Failed (exit 3) in 2m 05s");
    expect(runOutcomeText(run({ exit_code: 130 }))).toBe("Stopped after 2m 05s");
    expect(runOutcomeText(run({ ended_at: null, exit_code: null }))).toMatch(/^Running, started /);
  });
});
