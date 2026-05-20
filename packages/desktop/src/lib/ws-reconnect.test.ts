import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_AUTO_RECONNECT_FAILURES,
  RECONNECT_INTERVAL_MS,
  scheduleReconnect,
  resetReconnectState,
  clearReconnect,
  registerReconnector,
  unregisterReconnector,
  forceReconnect,
  forceReconnectAll,
} from "./ws-reconnect";

describe("ws-reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("caps automatic retries at a 240 second window", () => {
    expect(MAX_AUTO_RECONNECT_FAILURES).toBe(240);
    expect(RECONNECT_INTERVAL_MS).toBe(1000);
  });

  afterEach(() => {
    clearReconnect("test");
    clearReconnect("other");
    vi.useRealTimers();
  });

  it("calls connect after base delay", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);

    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("uses the same 1s delay on successive failures", () => {
    const connect = vi.fn();

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledTimes(1);

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS - 1);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("pauses automatic reconnects after 240 consecutive failures", () => {
    const connect = vi.fn();
    const onManualRequired = vi.fn();
    registerReconnector("test", connect, { onManualRequired });

    for (let i = 0; i < MAX_AUTO_RECONNECT_FAILURES; i++) {
      scheduleReconnect("test", connect);
      vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    }

    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);

    expect(connect).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_FAILURES);
    expect(onManualRequired).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent schedules", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);
    scheduleReconnect("test", connect);
    scheduleReconnect("test", connect);

    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("resetReconnectState resets the failure count and manual pause", () => {
    const connect = vi.fn();
    const onManualRequired = vi.fn();
    registerReconnector("test", connect, { onManualRequired });

    for (let i = 0; i < MAX_AUTO_RECONNECT_FAILURES; i++) {
      scheduleReconnect("test", connect);
      vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    }
    scheduleReconnect("test", connect);
    expect(onManualRequired).toHaveBeenCalledOnce();

    resetReconnectState("test");
    scheduleReconnect("test", connect);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
    expect(connect).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_FAILURES + 1);
  });

  it("clearReconnect cancels pending timer", () => {
    const connect = vi.fn();
    scheduleReconnect("test", connect);
    clearReconnect("test");

    vi.advanceTimersByTime(RECONNECT_INTERVAL_MS * 5);
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
      vi.advanceTimersByTime(RECONNECT_INTERVAL_MS * 2);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("automatic forceReconnect does not bypass manual pause", () => {
      const connect = vi.fn();
      const onManualRequired = vi.fn();
      registerReconnector("force-a", connect, { onManualRequired });

      for (let i = 0; i < MAX_AUTO_RECONNECT_FAILURES; i++) {
        scheduleReconnect("force-a", connect);
        vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
      }

      scheduleReconnect("force-a", connect);
      expect(onManualRequired).toHaveBeenCalledOnce();

      forceReconnect("force-a");
      expect(connect).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_FAILURES);
    });

    it("manual forceReconnect resets the pause and starts a fresh retry window", () => {
      const connect = vi.fn();
      const onManualRequired = vi.fn();
      registerReconnector("force-a", connect, { onManualRequired });

      for (let i = 0; i < MAX_AUTO_RECONNECT_FAILURES; i++) {
        scheduleReconnect("force-a", connect);
        vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
      }

      scheduleReconnect("force-a", connect);
      expect(onManualRequired).toHaveBeenCalledOnce();

      forceReconnect("force-a", { bypassManualPause: true });
      expect(connect).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_FAILURES + 1);
      scheduleReconnect("force-a", connect);
      vi.advanceTimersByTime(RECONNECT_INTERVAL_MS);
      expect(connect).toHaveBeenCalledTimes(MAX_AUTO_RECONNECT_FAILURES + 2);
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
