import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWsSessionRetentionForTests,
  retainWsSession,
  WS_SESSION_EVICTION_MS,
} from "./ws-session-retention";

const mocks = vi.hoisted(() => ({
  disconnect: vi.fn(),
  sessions: {} as Record<string, { sessionDbId: number | null; serverSessionId: string }>,
  statuses: {} as Record<number, { status: "idle" | "agent" | "question" }>,
}));

vi.mock("@/stores/ws-session-store", () => ({
  useWsSessionStore: {
    getState: () => ({ sessions: mocks.sessions, disconnect: mocks.disconnect }),
  },
}));

vi.mock("@/stores/session-status-store", () => ({
  useSessionStatusStore: {
    getState: () => ({ bySession: mocks.statuses }),
  },
}));

describe("ws-session-retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.disconnect.mockClear();
    mocks.sessions = {};
    mocks.statuses = {};
  });

  afterEach(() => {
    clearWsSessionRetentionForTests();
    vi.useRealTimers();
  });

  it("evicts an unreferenced idle session after the grace period", () => {
    mocks.sessions["session-1"] = { sessionDbId: 42, serverSessionId: "runtime-1" };
    mocks.statuses[42] = { status: "idle" };
    const release = retainWsSession("session-1");

    release();
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS);

    expect(mocks.disconnect).toHaveBeenCalledWith("session-1");
  });

  it("evicts an uninitialized session using the store's empty runtime-id sentinel", () => {
    mocks.sessions["session-1"] = { sessionDbId: null, serverSessionId: "" };
    const release = retainWsSession("session-1");

    release();
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS);

    expect(mocks.disconnect).toHaveBeenCalledWith("session-1");
  });

  it("does not evict an active session", () => {
    mocks.sessions["session-1"] = { sessionDbId: 42, serverSessionId: "runtime-1" };
    mocks.statuses[42] = { status: "agent" };
    const release = retainWsSession("session-1");

    release();
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS * 2);

    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("evicts once a previously active session becomes idle", () => {
    mocks.sessions["session-1"] = { sessionDbId: 42, serverSessionId: "runtime-1" };
    mocks.statuses[42] = { status: "agent" };
    const release = retainWsSession("session-1");

    release();
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS);
    mocks.statuses[42] = { status: "idle" };
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS);

    expect(mocks.disconnect).toHaveBeenCalledWith("session-1");
  });

  it("cancels eviction when a second consumer retains the session", () => {
    mocks.sessions["session-1"] = { sessionDbId: null, serverSessionId: "" };
    const firstRelease = retainWsSession("session-1");
    firstRelease();
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS - 1);

    retainWsSession("session-1");
    vi.advanceTimersByTime(WS_SESSION_EVICTION_MS);

    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
