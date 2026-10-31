import { afterEach, describe, expect, it, vi } from "vitest";
import { installSessionIntegration, mountSessionApplication } from "./session-integration";
import {
  useSessionStatusStore,
  installSessionStatusEffects,
  type SessionStatusEffects,
} from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { noteUserPrompt } from "@/lib/auto-layout/auto-layout-controller";
import { acknowledgeForMe } from "@/stores/for-me-ack";
import { serverTurnStartLocalMs } from "@/stores/server-turn-start";

vi.mock("@/lib/auto-layout/auto-layout-controller", async (original) => ({
  ...(await original<typeof import("@/lib/auto-layout/auto-layout-controller")>()),
  noteUserPrompt: vi.fn(),
}));
vi.mock("@/stores/for-me-ack", async (original) => ({
  ...(await original<typeof import("@/stores/for-me-ack")>()),
  acknowledgeForMe: vi.fn(),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CLOSED = 3;
  static OPEN = 1;
  constructor() {
    MockWebSocket.instances.push(this);
  }
  readyState = MockWebSocket.OPEN;
  addEventListener(): void {}
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useWsSessionStore.setState({ sessions: {} });
  useSessionStatusStore.setState({
    bySession: {},
    connectionEpoch: 0,
    isConnected: false,
    snapshotSeq: 0,
    epoch: null,
  });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("session application composition", () => {
  it("installs before the first connection/dispatch and disposes once after unmount", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    const unmount = vi.fn(() => {
      // React cleanup still has its integration available until unmount finishes.
      useWsSessionStore.getState().sendPrompt("first", "cleanup prompt");
    });
    dispose = mountSessionApplication(() => {
      useSessionStatusStore.getState().connect();
      useSessionStatusStore.setState({
        bySession: {
          7: { featureId: 7, status: "agent", kind: null, seq: 1, turnStartedAtMs: 123 },
        },
      });
      useWsSessionStore.setState({
        sessions: { first: { ...createSessionEntry(), featureId: 7 } },
      });
      useWsSessionStore.getState().sendPrompt("first", "first prompt");
      return unmount;
    });
    expect(noteUserPrompt).toHaveBeenCalledExactlyOnceWith(7);
    expect(acknowledgeForMe).toHaveBeenCalledExactlyOnceWith(7);
    expect(serverTurnStartLocalMs(7)).toBe(123);
    const ws = MockWebSocket.instances.at(-1)!;
    dispose();
    dispose();
    expect(unmount).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
    expect(useWsSessionStore.getState().sessions).toEqual({});
    expect(serverTurnStartLocalMs(7)).toBeNull();
    expect(() => useSessionStatusStore.getState().connect()).toThrow("must be installed");
    expect(noteUserPrompt).toHaveBeenCalledTimes(2);
  });

  it("settles queued delivery and releases feature sockets before uninstalling effects", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    let delivery: Promise<void>;
    dispose = mountSessionApplication(() => {
      useWsSessionStore.getState().connect("queued");
      useWsSessionStore.setState((state) => ({
        sessions: { ...state.sessions, queued: { ...state.sessions.queued, featureId: 7 } },
      }));
      delivery = useWsSessionStore.getState().deliverPrompt("queued", "held prompt");
      return () => {};
    });
    const rejected = expect(delivery!).rejects.toThrow();
    const ws = MockWebSocket.instances.at(-1)!;
    dispose();
    await rejected;
    expect(ws.close).toHaveBeenCalledOnce();
    expect(useWsSessionStore.getState().sessions.queued).toBeUndefined();
  });

  it("rejects duplicate owners and allows a fresh mount after disposal", () => {
    dispose = installSessionIntegration();
    expect(() => installSessionIntegration()).toThrow("already installed");
    dispose();
    dispose = installSessionIntegration();
  });

  it("uninstalls when mounting fails", () => {
    expect(() =>
      mountSessionApplication(() => {
        throw new Error("mount failed");
      }),
    ).toThrow("mount failed");
    dispose = installSessionIntegration();
  });

  it("an old status-registration cleanup cannot uninstall a newer registration", () => {
    const effects: SessionStatusEffects = {
      handleEnvelope: vi.fn(),
      snapshotApplied: vi.fn(),
      updateApplied: vi.fn(),
    };
    const oldCleanup = installSessionStatusEffects(effects);
    oldCleanup();
    dispose = installSessionStatusEffects(effects);
    oldCleanup();
    expect(() => installSessionStatusEffects(effects)).toThrow("already installed");
  });
});
