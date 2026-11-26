import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_RESPONSE_TIMEOUT_MS,
  createCloseCoordinator,
  windowCloseQuits,
} from "./close-coordinator";

function harness({ available = true, delivered = true } = {}) {
  const ask = vi.fn(() => delivered);
  const finish = vi.fn();
  const reportUnanswered = vi.fn();
  const coordinator = createCloseCoordinator({
    renderer: { canAnswer: () => available, ask },
    finish,
    reportUnanswered,
  });
  return { coordinator, ask, finish, reportUnanswered };
}

describe("close coordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes just the window on macOS and quits when the last window closes on Linux", () => {
    expect(windowCloseQuits("darwin")).toBe(false);
    expect(windowCloseQuits("linux")).toBe(true);
  });

  it("uses the same quit after a response, a timeout, or when nobody can answer", () => {
    const confirmed = harness();
    confirmed.coordinator.request(true);
    confirmed.coordinator.confirm(1);

    const silent = harness();
    silent.coordinator.request(true);
    vi.advanceTimersByTime(CLOSE_RESPONSE_TIMEOUT_MS);

    const noWindow = harness({ available: false });
    noWindow.coordinator.request(true);
    expect(noWindow.ask).not.toHaveBeenCalled();

    const deadRenderer = harness({ delivered: false });
    deadRenderer.coordinator.request(true);
    expect(deadRenderer.ask).toHaveBeenCalledTimes(1);

    for (const { finish } of [confirmed, silent, noWindow, deadRenderer]) {
      expect(finish).toHaveBeenCalledExactlyOnceWith({ id: 1, quitting: true });
    }
  });

  it("waits for a visible confirmation and respects Cancel even after another quit request", () => {
    const { coordinator, ask, finish } = harness();
    coordinator.request(true);
    coordinator.acknowledge(1);
    coordinator.request(true);
    vi.advanceTimersByTime(CLOSE_RESPONSE_TIMEOUT_MS * 2);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    coordinator.cancel(1);
    coordinator.rendererLost();
    expect(finish).not.toHaveBeenCalled();
  });

  it.each(["rendererLost", "rendererReset"] as const)(
    "finishes the quit if the visible confirmation is lost through %s",
    (loss) => {
      const { coordinator, finish } = harness();
      coordinator.request(true);
      coordinator.acknowledge(1);
      coordinator[loss]();
      coordinator.confirm(1);

      expect(finish).toHaveBeenCalledExactlyOnceWith({ id: 1, quitting: true });
    },
  );

  it("keeps window-only close separate even when the renderer cannot answer", () => {
    const { coordinator, finish } = harness({ available: false });
    coordinator.request(false);
    expect(finish).toHaveBeenCalledExactlyOnceWith({ id: 1, quitting: false });
  });

  it("requires a new confirmation when an explicit quit supersedes a window-only close", () => {
    const { coordinator, finish, ask } = harness();
    coordinator.request(false);
    coordinator.request(true);
    coordinator.acknowledge(1);
    coordinator.cancel(1);
    coordinator.confirm(1);
    expect(finish).not.toHaveBeenCalled();
    expect(ask).toHaveBeenLastCalledWith({ id: 2, quitting: true });

    coordinator.confirm(2);
    expect(finish).toHaveBeenCalledExactlyOnceWith({ id: 2, quitting: true });
  });
});
