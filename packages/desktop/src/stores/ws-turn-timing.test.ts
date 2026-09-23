import { describe, expect, it } from "vitest";
import type { TurnLifecycle } from "./ws-turn-lifecycle";
import {
  anchorTurnTiming,
  createTurnTiming,
  completeTurnTimingSegment,
  elapsedTurnTiming,
  formatTurnDuration,
  resumeTurnTimingAfterSuspend,
  suspendTurnTiming,
  transitionTurnTiming,
} from "./ws-turn-timing";

describe("ws turn timing", () => {
  const active: TurnLifecycle = { phase: "active" };
  const permissionPaused: TurnLifecycle = {
    phase: "paused",
    reason: "permission",
  };
  const questionPaused: TurnLifecycle = { phase: "paused", reason: "question" };
  const planPaused: TurnLifecycle = { phase: "paused", reason: "planApproval" };
  const suspendedPaused: TurnLifecycle = {
    phase: "paused",
    reason: "suspended",
  };
  const terminal: TurnLifecycle = { phase: "terminal", reason: "completed" };

  it("tracks total, active, and user-pending elapsed time across a turn", () => {
    let timing = createTurnTiming();

    timing = transitionTurnTiming(timing, { phase: "idle" }, active, 1_000);
    timing = transitionTurnTiming(timing, active, permissionPaused, 4_000);
    timing = transitionTurnTiming(timing, permissionPaused, active, 9_000);
    timing = transitionTurnTiming(timing, active, questionPaused, 12_000);
    timing = transitionTurnTiming(timing, questionPaused, active, 14_000);
    timing = transitionTurnTiming(timing, active, planPaused, 15_000);
    timing = transitionTurnTiming(timing, planPaused, terminal, 18_000);

    expect(timing.completed).toEqual({
      totalMs: 17_000,
      activeMs: 7_000,
      userPendingMs: 10_000,
    });
  });

  it("keeps total running through user gates but excludes suspended pauses from user wait", () => {
    let timing = createTurnTiming();

    timing = transitionTurnTiming(timing, { phase: "idle" }, active, 1_000);
    timing = transitionTurnTiming(timing, active, suspendedPaused, 3_000);

    expect(elapsedTurnTiming(timing, suspendedPaused, 8_000)).toEqual({
      totalMs: 7_000,
      activeMs: 2_000,
      userPendingMs: 0,
    });
  });

  it("resets the previous completion when a new active turn starts", () => {
    let timing = completeTurnTimingSegment(createTurnTiming(), active, terminal, 1_000, 4_000);

    timing = transitionTurnTiming(timing, terminal, active, 10_000);

    expect(timing.completed).toBeNull();
    expect(elapsedTurnTiming(timing, active, 12_000)?.totalMs).toBe(2_000);
  });

  it("starts the timer when bootstrapping straight into a paused gate", () => {
    // Sessions hydrated from a persisted snapshot can land directly in a
    // paused state (pending question / permission) without ever going
    // through `idle → active`. The live "Working - Xs" label has to start
    // ticking from this entry point too, otherwise the UI stays on a bare
    // "Working" until the gate resolves.
    let timing = createTurnTiming();

    timing = transitionTurnTiming(timing, { phase: "idle" }, questionPaused, 1_000);

    expect(timing.startedAt).toBe(1_000);
    expect(elapsedTurnTiming(timing, questionPaused, 4_500)?.totalMs).toBe(3_500);

    timing = transitionTurnTiming(timing, questionPaused, active, 6_000);
    timing = transitionTurnTiming(timing, active, terminal, 8_000);

    expect(timing.completed).toEqual({
      totalMs: 7_000,
      activeMs: 2_000,
      userPendingMs: 5_000,
    });
  });

  it("restarts the timer when a paused turn ends and the next one bootstraps paused again", () => {
    let timing = createTurnTiming();
    timing = transitionTurnTiming(timing, { phase: "idle" }, questionPaused, 1_000);
    timing = transitionTurnTiming(timing, questionPaused, terminal, 5_000);

    timing = transitionTurnTiming(timing, terminal, permissionPaused, 10_000);
    expect(timing.startedAt).toBe(10_000);
    expect(timing.completed).toBeNull();
    expect(elapsedTurnTiming(timing, permissionPaused, 12_500)?.totalMs).toBe(2_500);
  });

  it("anchors Worked to the server start but accrues buckets only from local observation", () => {
    // A turn that started at t=1s is first observed at t=61s. The unobserved
    // minute belongs to Worked but must not be booked as agent time.
    let timing = anchorTurnTiming(1_000, 61_000);

    timing = transitionTurnTiming(timing, active, terminal, 71_000);

    expect(timing.completed).toEqual({
      totalMs: 70_000,
      activeMs: 10_000,
      userPendingMs: 0,
    });
  });

  it("excludes the sleep gap from buckets across a suspend/resume cycle", () => {
    let timing = createTurnTiming();
    timing = transitionTurnTiming(timing, { phase: "idle" }, active, 1_000);

    timing = suspendTurnTiming(timing, active, 5_000);
    expect(timing.activeMs).toBe(4_000);
    expect(timing.segmentStartedAt).toBeNull();

    // Machine wakes 100s later; the gap lands in no bucket, but Worked still
    // spans the turn's real wall-clock time.
    timing = resumeTurnTimingAfterSuspend(timing, 105_000);
    timing = transitionTurnTiming(timing, active, terminal, 110_000);

    expect(timing.completed).toEqual({
      totalMs: 109_000,
      activeMs: 9_000,
      userPendingMs: 0,
    });
  });

  it("books the pre-suspend segment of a gated turn as user wait", () => {
    let timing = createTurnTiming();
    timing = transitionTurnTiming(timing, { phase: "idle" }, permissionPaused, 1_000);

    timing = suspendTurnTiming(timing, permissionPaused, 4_000);

    expect(timing.userPendingMs).toBe(3_000);
    expect(timing.activeMs).toBe(0);
  });

  it("drops the stale segment when resume runs without a suspend fold", () => {
    let timing = createTurnTiming();
    timing = transitionTurnTiming(timing, { phase: "idle" }, active, 1_000);

    // Renderer froze before the suspend handler ran: segmentStartedAt still
    // points at the pre-sleep clock. Resume re-opens it at wake time so the
    // sleep gap is dropped instead of booked as agent time.
    timing = resumeTurnTimingAfterSuspend(timing, 105_000);
    timing = transitionTurnTiming(timing, active, terminal, 110_000);

    expect(timing.completed).toEqual({
      totalMs: 109_000,
      activeMs: 5_000,
      userPendingMs: 0,
    });
  });

  it("does not start a timer for the at-rest user-paused state", () => {
    const userPaused: TurnLifecycle = { phase: "paused", reason: "user" };
    let timing = createTurnTiming();

    // Hydrating a conversation persisted as paused/waiting is not a turn.
    timing = transitionTurnTiming(timing, { phase: "idle" }, userPaused, 1_000);
    expect(timing.startedAt).toBeNull();
    expect(elapsedTurnTiming(timing, userPaused, 60_000)).toBeNull();

    // The next prompt starts a fresh turn instead of folding the time the
    // conversation sat open into its totals.
    timing = transitionTurnTiming(timing, userPaused, active, 60_000);
    timing = transitionTurnTiming(timing, active, terminal, 63_000);

    expect(timing.completed).toEqual({
      totalMs: 3_000,
      activeMs: 3_000,
      userPendingMs: 0,
    });
  });

  it("formats durations using seconds, then minutes, then hours", () => {
    expect(formatTurnDuration(4_400)).toBe("4s");
    expect(formatTurnDuration(65_000)).toBe("1m 5s");
    expect(formatTurnDuration(3_665_000)).toBe("1h 1m 5s");
  });
});
