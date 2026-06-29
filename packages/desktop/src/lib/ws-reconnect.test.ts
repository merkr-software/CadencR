import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RECONNECT_INTERVAL_MS,
  RECONNECT_MAX_MS,
  AUTO_RECONNECT_TIMEOUT_MS,
  scheduleReconnect,
  resetReconnectState,
  clearReconnect,
  registerReconnector,
  unregisterReconnector,
  forceReconnect,
  forceReconnectAll,
  notifyRateLimited,
  clearRateLimit,
} from "./ws-reconnect";

describe("ws-reconnect", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin jitter to 0 so backoff delays are deterministic (delay === base).
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    clearReconnect("test");
    clearReconnect("other");
    clearRateLimit();
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("exposes the base and max delays", () => {
    expect(RECONNECT_INTERVAL_MS).toBe(1000);
    expect(RECONNECT_MAX_MS).toBe(30_000);
  });

  it("calls connect after the base delay on the first failure", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);

    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS - 1);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("backs off exponentially on successive failures", () => {
    const connect = vi.fn();

    // 1st failure -> 1000ms
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(1000);
    expect(connect).toHaveBeenCalledTimes(1);

    // 2nd failure -> 2000ms
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(1999);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // 3rd failure -> 4000ms
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(3999);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("caps the backoff at RECONNECT_MAX_MS", () => {
    const connect = vi.fn();
    // Drive five failures: 1s, 2s, 4s, 8s, 16s.
    const ramp = [1000, 2000, 4000, 8000, 16000];
    for (const d of ramp) {
      scheduleReconnect("test", connect);
      vi.advanceTimersByTime(d);
    }
    expect(connect).toHaveBeenCalledTimes(ramp.length);

    // 6th failure would be 32s un-capped; it must land at exactly 30s.
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_MAX_MS - 1);
    expect(connect).toHaveBeenCalledTimes(ramp.length);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(ramp.length + 1);
  });

  it("pauses automatic reconnects after the 240s window, with far fewer attempts than a 1s retry", () => {
    const connect = vi.fn();
    const onManualRequired = vi.fn();
    registerReconnector("test", connect, { onManualRequired });

    const delays = [1000, 2000, 4000, 8000, 16000, RECONNECT_MAX_MS];
    let i = 0;
    while (onManualRequired.mock.calls.length === 0 && i < 100) {
      scheduleReconnect("test", connect);
      vi.advanceTimersByTime(delays[Math.min(i, delays.length - 1)]);
      i++;
    }

    expect(onManualRequired).toHaveBeenCalledOnce();
    // Backoff turns ~240 fixed-interval handshakes into a handful.
    expect(connect.mock.calls.length).toBeLessThan(20);
    expect(connect.mock.calls.length).toBeGreaterThan(5);
  });

  it("deduplicates concurrent schedules", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);
    scheduleReconnect("test", connect);
    scheduleReconnect("test", connect);

    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("resetReconnectState clears the failure count so the next retry uses the base delay", () => {
    const connect = vi.fn();

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(1000);
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(2000);
    expect(connect).toHaveBeenCalledTimes(2);

    resetReconnectState("test");

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("notifyRateLimited defers retries until the Retry-After window passes", () => {
    const connect = vi.fn();
    notifyRateLimited(5000);

    // First failure would normally fire at 1s, but the rate-limit hold wins.
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(4999);
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("clearRateLimit lifts the hold immediately", () => {
    const connect = vi.fn();
    notifyRateLimited(60_000);
    clearRateLimit();

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("clearReconnect cancels pending timer", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);
    clearReconnect("test");

    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(connect).not.toHaveBeenCalled();
  });

  it("isolates keys from each other", () => {
    const connectA = vi.fn();
    const connectB = vi.fn();

    scheduleReconnect("test", connectA);
    scheduleReconnect("other", connectB);

    clearReconnect("test");
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);

    expect(connectA).not.toHaveBeenCalled();
    expect(connectB).toHaveBeenCalledOnce();
  });

  describe("forceReconnect / registerReconnector", () => {
    afterEach(() => {
      clearReconnect("force-a");
      clearReconnect("force-b");
    });

    it("forceReconnect invokes the registered connector immediately", () => {
      const connect = vi.fn();
      registerReconnector("force-a", connect);
      forceReconnect("force-a");
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("forceReconnect cancels a pending scheduled timer", () => {
      const connect = vi.fn();
      scheduleReconnect("force-a", connect);
      forceReconnect("force-a");
      expect(connect).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(RECONNECT_MAX_MS);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("automatic forceReconnect does not bypass manual pause", () => {
      const connect = vi.fn();
      const onManualRequired = vi.fn();
      registerReconnector("force-a", connect, { onManualRequired });

      // First failure starts the 240s window; burning past it then re-scheduling
      // pauses the key into manual-only.
      scheduleReconnect("force-a", connect);
      vi.advanceTimersByTime(AUTO_RECONNECT_TIMEOUT_MS);
      scheduleReconnect("force-a", connect);
      expect(onManualRequired).toHaveBeenCalledOnce();

      const callsBefore = connect.mock.calls.length;
      forceReconnect("force-a");
      expect(connect).toHaveBeenCalledTimes(callsBefore);
    });

    it("manual forceReconnect resets the pause and starts a fresh retry window", () => {
      const connect = vi.fn();
      const onManualRequired = vi.fn();
      registerReconnector("force-a", connect, { onManualRequired });

      scheduleReconnect("force-a", connect);
      vi.advanceTimersByTime(AUTO_RECONNECT_TIMEOUT_MS);
      scheduleReconnect("force-a", connect);
      expect(onManualRequired).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(1);

      forceReconnect("force-a", { bypassManualPause: true });
      expect(connect).toHaveBeenCalledTimes(2);

      // Fresh window: the next schedule uses the base delay again.
      scheduleReconnect("force-a", connect);
      vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it("automatic forceReconnect respects an active rate-limit hold", () => {
      const connect = vi.fn();
      registerReconnector("force-a", connect);
      notifyRateLimited(30_000);

      forceReconnect("force-a");
      expect(connect).not.toHaveBeenCalled();
    });

    it("manual forceReconnect lifts the rate-limit hold and reconnects", () => {
      const connect = vi.fn();
      registerReconnector("force-a", connect);
      notifyRateLimited(30_000);

      forceReconnect("force-a", { bypassManualPause: true });
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("forceReconnect on an unknown key is a no-op", () => {
      expect(() => forceReconnect("missing")).not.toThrow();
    });

    it("forceReconnectAll triggers every registered connector once", () => {
      const a = vi.fn();
      const b = vi.fn();
      registerReconnector("force-a", a);
      registerReconnector("force-b", b);
      forceReconnectAll();
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it("unregisterReconnector removes a key from forceReconnectAll", () => {
      const a = vi.fn();
      registerReconnector("force-a", a);
      unregisterReconnector("force-a");
      forceReconnectAll();
      expect(a).not.toHaveBeenCalled();
    });
  });
});
