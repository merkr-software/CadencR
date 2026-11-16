import { afterEach, describe, expect, it } from "vitest";
import { observeServerClock, resetServerClock } from "@/lib/server-clock";
import {
  elapsedTurnClock,
  formatWorkedLabel,
  formatWorkingLabel,
  parseModelSwitch,
  parseTurnSummary,
  turnClockFromStatus,
} from "./turn-clock";

afterEach(() => resetServerClock());

describe("turn clock", () => {
  it("is read from a busy status entry only", () => {
    const entry = {
      status: "agent",
      kind: null,
      featureId: 1,
      seq: 1,
      turnStartedAtMs: 1_000,
      waitingMs: 500,
      model: "opus",
    } as const;
    expect(turnClockFromStatus(entry)).toEqual({
      startedAtMs: 1_000,
      waitingMs: 500,
      waitingSinceMs: null,
      model: "opus",
    });
    expect(turnClockFromStatus({ ...entry, status: "idle" })).toBeNull();
    expect(turnClockFromStatus({ ...entry, turnStartedAtMs: null })).toBeNull();
    expect(turnClockFromStatus(null)).toBeNull();
  });

  it("splits elapsed time into waiting and agent time, the open gate included", () => {
    const clock = { startedAtMs: 0, waitingMs: 2_000, waitingSinceMs: 8_000, model: null };
    expect(elapsedTurnClock(clock, 10_000)).toEqual({
      totalMs: 10_000,
      waitingMs: 4_000,
      agentMs: 6_000,
    });
  });

  it("measures on the server clock, whatever this device's skew", () => {
    // The server runs 3s ahead of this device.
    observeServerClock(Date.now() + 3_000);
    const startedAtMs = Date.now() + 3_000 - 10_000;
    const clock = { startedAtMs, waitingMs: 0, waitingSinceMs: null, model: null };
    const { totalMs } = elapsedTurnClock(clock, Date.now());
    expect(Math.round(totalMs / 1_000)).toBe(10);
  });

  it("names the model and the elapsed time on the working line when known", () => {
    expect(formatWorkingLabel("claude-opus-5-5", 65_000)).toBe("Working - claude-opus-5-5 - 1m 5s");
    expect(formatWorkingLabel(null, 5_000)).toBe("Working - 5s");
    expect(formatWorkingLabel(null, null)).toBe("Working");
  });
});

describe("persisted transcript rows", () => {
  it("reads a turn summary as Worked - model - total - waiting - agent", () => {
    const summary = parseTurnSummary(
      JSON.stringify({ totalMs: 125_000, waitingMs: 5_000, agentMs: 120_000, models: ["gpt-5.5"] }),
    );
    expect(summary && formatWorkedLabel(summary)).toBe(
      "Worked - gpt-5.5 - 2m 5s - Waiting 5s - Agent 2m 0s",
    );
  });

  it("splits whole seconds so waiting and agent time add up to the total shown", () => {
    const summary = parseTurnSummary(
      JSON.stringify({
        totalMs: 34_030,
        waitingMs: 24_967,
        agentMs: 9_063,
        models: ["gpt-6.1-terra"],
      }),
    );
    expect(summary && formatWorkedLabel(summary)).toBe(
      "Worked - gpt-6.1-terra - 34s - Waiting 24s - Agent 10s",
    );
  });

  it("joins the models a turn switched between and tolerates a malformed row", () => {
    const summary = parseTurnSummary(
      JSON.stringify({ totalMs: 3_000, waitingMs: 0, models: ["opus", "sonnet"] }),
    );
    expect(summary && formatWorkedLabel(summary)).toBe(
      "Worked - opus → sonnet - 3s - Waiting 0s - Agent 3s",
    );
    expect(parseTurnSummary("not json")).toBeNull();
    expect(parseTurnSummary(JSON.stringify({ models: [] }))).toBeNull();
  });

  it("reads a model switch", () => {
    expect(parseModelSwitch('{"from":"opus","to":"sonnet"}')).toEqual({
      from: "opus",
      to: "sonnet",
    });
    expect(parseModelSwitch('{"from":"opus"}')).toBeNull();
  });
});
