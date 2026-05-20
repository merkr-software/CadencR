import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/api/client", () => ({
  pingHealth: vi.fn(),
}));

vi.mock("@/lib/ws-reconnect", () => ({
  AUTO_RECONNECT_TIMEOUT_SECONDS: 240,
  forceReconnectAll: vi.fn(),
}));

import { useConnectionStatusStore } from "./connection-status-store";
import { pingHealth } from "@/api/client";
import { forceReconnectAll as forceReconnectAllWs } from "@/lib/ws-reconnect";
import { toast } from "sonner";

beforeEach(() => {
  // Reset store to initial state.
  useConnectionStatusStore.setState({
    status: "connected",
    reason: null,
    lastConnectedAt: null,
    sources: {},
  });
  vi.clearAllMocks();
});

describe("connection-status-store / aggregation", () => {
  it("starts connected with no sources and no lastConnectedAt", () => {
    const s = useConnectionStatusStore.getState();
    expect(s.status).toBe("connected");
    expect(s.reason).toBeNull();
    expect(s.lastConnectedAt).toBeNull();
  });

  it("any reconnecting source moves global to reconnecting with that reason", () => {
    useConnectionStatusStore.getState().reportSource("ws-a", "reconnecting", "drop A");
    const s = useConnectionStatusStore.getState();
    expect(s.status).toBe("reconnecting");
    expect(s.reason).toBe("drop A");
  });

  it("health=disconnected dominates reconnecting WS sources", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    reportSource("ws-a", "reconnecting", "drop A");
    reportSource("health", "disconnected", "Backend unreachable");
    const s = useConnectionStatusStore.getState();
    expect(s.status).toBe("disconnected");
    expect(s.reason).toBe("Backend unreachable");
  });

  it("manual reconnect required dominates health and reconnecting sources", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    reportSource("ws-a", "reconnecting", "drop A");
    reportSource("health", "disconnected", "Backend unreachable");
    reportSource(
      "ws-a",
      "manual_reconnect_required",
      "Backend WebSocket failed to reconnect for 240 seconds",
    );
    const s = useConnectionStatusStore.getState();
    expect(s.status).toBe("manual_reconnect_required");
    expect(s.reason).toBe("Backend WebSocket failed to reconnect for 240 seconds");
  });

  it("returns to connected when all sources clear or report connected", () => {
    const { reportSource, clearSource } = useConnectionStatusStore.getState();
    reportSource("ws-a", "reconnecting", "drop A");
    reportSource("ws-b", "reconnecting", "drop B");
    reportSource("ws-a", "connected");
    expect(useConnectionStatusStore.getState().status).toBe("reconnecting");
    clearSource("ws-b");
    expect(useConnectionStatusStore.getState().status).toBe("connected");
  });

  it("sets lastConnectedAt only on transition into connected from non-connected", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    // First: never connected, source goes connected — but global was already
    // "connected" (initial state) so no transition fires.
    reportSource("ws-a", "connected");
    expect(useConnectionStatusStore.getState().lastConnectedAt).toBeNull();

    // Now drop and recover — that's the real transition.
    reportSource("ws-a", "reconnecting", "drop");
    expect(useConnectionStatusStore.getState().status).toBe("reconnecting");
    const before = Date.now();
    reportSource("ws-a", "connected");
    const after = Date.now();
    const ts = useConnectionStatusStore.getState().lastConnectedAt;
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  it("does not overwrite lastConnectedAt when staying in connected", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    reportSource("ws-a", "reconnecting", "drop");
    reportSource("ws-a", "connected");
    const first = useConnectionStatusStore.getState().lastConnectedAt;
    // A second `connected` report should not bump the timestamp.
    reportSource("ws-a", "connected");
    expect(useConnectionStatusStore.getState().lastConnectedAt).toBe(first);
  });

  it("ignores no-op reports (same status + same reason)", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    reportSource("ws-a", "reconnecting", "drop");
    const sourcesRef = useConnectionStatusStore.getState().sources;
    reportSource("ws-a", "reconnecting", "drop");
    // Same object identity proves no `set()` ran.
    expect(useConnectionStatusStore.getState().sources).toBe(sourcesRef);
  });

  it("clearSource recomputes aggregate", () => {
    const { reportSource, clearSource } = useConnectionStatusStore.getState();
    reportSource("health", "disconnected", "Backend unreachable");
    expect(useConnectionStatusStore.getState().status).toBe("disconnected");
    clearSource("health");
    expect(useConnectionStatusStore.getState().status).toBe("connected");
    expect(useConnectionStatusStore.getState().reason).toBeNull();
  });
});

describe("connection-status-store / probeHealth", () => {
  it("reports connected on a successful ping", async () => {
    vi.mocked(pingHealth).mockResolvedValueOnce({ ok: true });
    await useConnectionStatusStore.getState().probeHealth();
    expect(useConnectionStatusStore.getState().sources.health).toEqual({
      status: "connected",
      reason: null,
    });
  });

  it("reports disconnected with the reason on a failed ping", async () => {
    vi.mocked(pingHealth).mockResolvedValueOnce({ ok: false, reason: "timed out" });
    await useConnectionStatusStore.getState().probeHealth();
    expect(useConnectionStatusStore.getState().sources.health).toEqual({
      status: "disconnected",
      reason: "timed out",
    });
    expect(useConnectionStatusStore.getState().status).toBe("disconnected");
  });
});

describe("connection-status-store / forceReconnectAll", () => {
  it("triggers ws-reconnect.forceReconnectAll and a fresh health probe", () => {
    vi.mocked(pingHealth).mockResolvedValueOnce({ ok: true });
    useConnectionStatusStore.getState().forceReconnectAll();
    expect(forceReconnectAllWs).toHaveBeenCalledWith({ bypassManualPause: false });
    expect(pingHealth).toHaveBeenCalledTimes(1);
  });

  it("manual force reconnect marks paused sources as reconnecting", () => {
    vi.mocked(pingHealth).mockResolvedValueOnce({ ok: true });
    useConnectionStatusStore
      .getState()
      .reportSource(
        "ws-a",
        "manual_reconnect_required",
        "Backend WebSocket failed to reconnect for 240 seconds",
      );

    useConnectionStatusStore.getState().forceReconnectAll({ bypassManualPause: true });

    expect(forceReconnectAllWs).toHaveBeenCalledWith({ bypassManualPause: true });
    expect(useConnectionStatusStore.getState().sources["ws-a"]).toEqual({
      status: "reconnecting",
      reason: "Retrying backend connection",
    });
  });
});

describe("connection-status-store / manual reconnect toast", () => {
  it("shows one persistent toast with a retry action when automatic reconnect pauses", () => {
    useConnectionStatusStore
      .getState()
      .reportSource(
        "ws-a",
        "manual_reconnect_required",
        "Backend WebSocket failed to reconnect for 240 seconds",
      );

    expect(toast.error).toHaveBeenCalledWith(
      "Backend reconnect paused",
      expect.objectContaining({
        id: "backend-manual-reconnect-required",
        description: expect.stringContaining("240 seconds"),
        duration: Infinity,
        action: expect.objectContaining({ label: "Retry now" }),
      }),
    );
  });

  it("toast retry action performs a manual reconnect", () => {
    vi.mocked(pingHealth).mockResolvedValueOnce({ ok: true });
    useConnectionStatusStore
      .getState()
      .reportSource(
        "ws-a",
        "manual_reconnect_required",
        "Backend WebSocket failed to reconnect for 240 seconds",
      );

    const options = vi.mocked(toast.error).mock.calls[0]?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    options?.action?.onClick?.();

    expect(forceReconnectAllWs).toHaveBeenCalledWith({ bypassManualPause: true });
  });

  it("dismisses the manual reconnect toast after reconnecting", () => {
    const { reportSource } = useConnectionStatusStore.getState();
    reportSource(
      "ws-a",
      "manual_reconnect_required",
      "Backend WebSocket failed to reconnect for 240 seconds",
    );
    vi.mocked(toast.dismiss).mockClear();

    reportSource("ws-a", "connected");

    expect(toast.dismiss).toHaveBeenCalledWith("backend-manual-reconnect-required");
  });
});
