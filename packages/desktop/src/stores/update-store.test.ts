import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridge } from "@/lib/desktop-bridge";
import { INITIAL_UPDATE_SNAPSHOT } from "@/shared/update-state";
import { useSessionStatusStore } from "./session-status-store";
import { useUpdateStore } from "./update-store";

vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: {
    installUpdate: vi.fn(() => Promise.resolve()),
    checkForUpdates: vi.fn(() => Promise.resolve(INITIAL_UPDATE_SNAPSHOT)),
  },
}));

function resetStore(): void {
  useUpdateStore.setState({ ...INITIAL_UPDATE_SNAPSHOT, installWhenAgentsFinish: false });
}

describe("update-store receive", () => {
  beforeEach(resetStore);

  it("adopts a newer main-process snapshot and keeps it over an older one", () => {
    const downloaded = { ...INITIAL_UPDATE_SNAPSHOT, revision: 3, status: "downloaded" as const };
    useUpdateStore.getState().receive(downloaded);
    useUpdateStore.getState().receive({ ...downloaded, revision: 2, status: "checking" });
    expect(useUpdateStore.getState()).toMatchObject({ revision: 3, status: "downloaded" });
  });

  it("shows a check as running only once the main process says so", async () => {
    vi.mocked(desktopBridge.checkForUpdates).mockResolvedValueOnce({
      ...INITIAL_UPDATE_SNAPSHOT,
      revision: 1,
      status: "checking",
    });
    const check = useUpdateStore.getState().checkForUpdates();
    expect(useUpdateStore.getState().status).toBe("idle");
    await check;
    expect(useUpdateStore.getState().status).toBe("checking");
  });
});

describe("update-store install when agents finish", () => {
  beforeEach(() => {
    resetStore();
    useUpdateStore.setState({ status: "downloaded", version: "0.2.0" });
    useUpdateStore.getState().cancelInstallWhenAgentsFinish();
    useSessionStatusStore.setState({ bySession: {} });
    vi.mocked(desktopBridge.installUpdate).mockClear();
  });

  function working(sessionId: number, status: "agent" | "question" | "idle"): void {
    useSessionStatusStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { status, kind: null, featureId: sessionId, seq: 1 },
      },
    }));
  }

  it("installs right away when no agent is working", () => {
    working(1, "question");
    useUpdateStore.getState().scheduleInstallWhenAgentsFinish();
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().installWhenAgentsFinish).toBe(false);
  });

  it("waits for the last working agent, then installs once", () => {
    working(1, "agent");
    working(2, "agent");
    useUpdateStore.getState().scheduleInstallWhenAgentsFinish();
    expect(useUpdateStore.getState().installWhenAgentsFinish).toBe(true);

    working(1, "idle");
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();
    working(2, "idle");
    working(2, "idle");
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().installWhenAgentsFinish).toBe(false);
  });

  it("does nothing after the user cancels", () => {
    working(1, "agent");
    useUpdateStore.getState().scheduleInstallWhenAgentsFinish();
    useUpdateStore.getState().cancelInstallWhenAgentsFinish();
    working(1, "idle");
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().installWhenAgentsFinish).toBe(false);
  });
});
