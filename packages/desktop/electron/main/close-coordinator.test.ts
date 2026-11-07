import { describe, expect, it, vi } from "vitest";
import { createCloseCoordinator, windowCloseQuits, type CloseRenderer } from "./close-coordinator";

function harness(renderer: Partial<CloseRenderer> = {}) {
  const finish = vi.fn();
  const reportUnanswered = vi.fn();
  const ask = vi.fn(renderer.ask ?? (() => true));
  const coordinator = createCloseCoordinator({
    renderer: { canAnswer: renderer.canAnswer ?? (() => true), ask },
    finish,
    reportUnanswered,
    responseTimeoutMs: 1_000,
  });
  return { coordinator, finish, reportUnanswered, ask };
}

describe("windowCloseQuits", () => {
  it("keeps the app running in the Dock on macOS", () => {
    expect(windowCloseQuits("darwin")).toBe(false);
  });

  it("quits when the last window closes on Linux", () => {
    expect(windowCloseQuits("linux")).toBe(true);
  });
});

describe("close coordinator", () => {
  it("forgets a cancelled quit, so a later window close only closes the window", () => {
    const { coordinator, finish, ask } = harness();

    coordinator.request(true);
    coordinator.acknowledge();
    coordinator.cancel();
    coordinator.request(windowCloseQuits("darwin"));
    coordinator.confirm({ resumeAgents: true });

    expect(ask).toHaveBeenLastCalledWith({ quitting: false });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ quitting: false }, { resumeAgents: true });
  });

  it("quits on Linux when the confirmed close is the last window", () => {
    const { coordinator, finish } = harness();

    coordinator.request(windowCloseQuits("linux"));
    coordinator.confirm({ resumeAgents: false });

    expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: false });
  });

  it("lets the latest request decide what a confirmation does", () => {
    const { coordinator, finish } = harness();

    coordinator.request(false);
    coordinator.request(true);
    coordinator.confirm({ resumeAgents: true });

    expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: true });
  });

  it("rejects a confirmation nothing is waiting for", () => {
    const { coordinator, finish } = harness();

    coordinator.request(true);
    coordinator.cancel();

    expect(() => coordinator.confirm({ resumeAgents: true })).toThrow(
      "No close is waiting for confirmation.",
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it("quits without asking when no renderer can answer", () => {
    const { coordinator, finish, reportUnanswered, ask } = harness({ canAnswer: () => false });

    coordinator.request(true);

    expect(ask).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: true });
    expect(reportUnanswered).toHaveBeenCalledWith(
      { quitting: true },
      "the window is not available",
    );
    expect(coordinator.pending()).toBeNull();
  });

  it("quits when the request cannot be delivered", () => {
    const { coordinator, finish } = harness({ ask: () => false });

    coordinator.request(true);

    expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: true });
  });

  it("closes with the default choice when the window never answers", () => {
    vi.useFakeTimers();
    try {
      const { coordinator, finish, reportUnanswered } = harness();

      coordinator.request(true);
      vi.advanceTimersByTime(999);
      expect(finish).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: true });
      expect(reportUnanswered).toHaveBeenCalledWith(
        { quitting: true },
        "the window did not answer within 1000 ms",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits on the user for as long as the confirmation is shown", () => {
    vi.useFakeTimers();
    try {
      const { coordinator, finish } = harness();

      coordinator.request(true);
      coordinator.acknowledge();
      vi.advanceTimersByTime(60_000);

      expect(finish).not.toHaveBeenCalled();
      expect(coordinator.pending()).toEqual({ quitting: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a waiting quit when the renderer is lost", () => {
    const { coordinator, finish } = harness();

    coordinator.request(true);
    coordinator.acknowledge();
    coordinator.rendererLost();

    expect(finish).toHaveBeenCalledWith({ quitting: true }, { resumeAgents: true });
  });

  it("ignores a lost renderer when nothing is waiting", () => {
    const { coordinator, finish } = harness();

    coordinator.rendererLost();

    expect(finish).not.toHaveBeenCalled();
  });

  it("drops a waiting close when the renderer reloads", () => {
    const { coordinator, finish } = harness();

    coordinator.request(true);
    coordinator.acknowledge();
    coordinator.rendererReset();

    expect(coordinator.pending()).toBeNull();
    expect(finish).not.toHaveBeenCalled();
  });
});
