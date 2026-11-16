import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridge } from "@/lib/desktop-bridge";
import { INITIAL_UPDATE_SNAPSHOT } from "@/shared/update-state";
import { useSessionStatusStore } from "./session-status-store";
import { followInstallWhenAgentsFinish, useUpdateStore } from "./update-store";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@/lib/api-errors", () => ({ toastError }));

vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: {
    installUpdate: vi.fn(() => Promise.resolve()),
    setInstallWhenAgentsFinish: vi.fn((pending: boolean) =>
      Promise.resolve({ ...INITIAL_UPDATE_SNAPSHOT, installWhenAgentsFinish: pending }),
    ),
    checkForUpdates: vi.fn(() => Promise.resolve(INITIAL_UPDATE_SNAPSHOT)),
  },
}));

function resetStore(): void {
  useUpdateStore.setState({ ...INITIAL_UPDATE_SNAPSHOT, installWishPending: false });
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
  let stopFollowing: () => void = () => undefined;

  beforeEach(() => {
    resetStore();
    useUpdateStore.setState({ status: "downloaded", version: "0.2.0", revision: 5 });
    useSessionStatusStore.setState({ bySession: {}, hasSnapshot: true, isConnected: true });
    vi.mocked(desktopBridge.installUpdate).mockClear();
    vi.mocked(desktopBridge.setInstallWhenAgentsFinish).mockClear();
    stopFollowing = followInstallWhenAgentsFinish();
  });

  afterEach(() => stopFollowing());

  function working(sessionId: number, status: "agent" | "question" | "idle"): void {
    useSessionStatusStore.setState((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { status, kind: null, featureId: sessionId, seq: 1 },
      },
    }));
  }

  /** The main process recorded the wish and published it. */
  function mainRecords(pending: boolean): void {
    const state = useUpdateStore.getState();
    state.receive({ ...state, revision: state.revision + 1, installWhenAgentsFinish: pending });
  }

  it("asks the main process to keep the wish and shows it only once confirmed", async () => {
    working(1, "agent");
    vi.mocked(desktopBridge.setInstallWhenAgentsFinish).mockImplementationOnce((pending) => {
      const state = useUpdateStore.getState();
      return Promise.resolve({ ...state, revision: 6, installWhenAgentsFinish: pending });
    });
    const request = useUpdateStore.getState().scheduleInstallWhenAgentsFinish();
    expect(desktopBridge.setInstallWhenAgentsFinish).toHaveBeenCalledWith(true);
    expect(useUpdateStore.getState()).toMatchObject({
      installWhenAgentsFinish: false,
      installWishPending: true,
    });
    await request;
    expect(useUpdateStore.getState()).toMatchObject({
      installWhenAgentsFinish: true,
      installWishPending: false,
    });
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();
  });

  it("installs as soon as the wish is recorded when no agent is working", () => {
    working(1, "question");
    mainRecords(true);
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("waits for the last working agent, then installs once", () => {
    working(1, "agent");
    working(2, "agent");
    mainRecords(true);

    working(1, "idle");
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();
    working(2, "idle");
    working(2, "idle");
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("waits for the agents' status after a reload before installing", () => {
    useSessionStatusStore.setState({ bySession: {}, hasSnapshot: false });
    mainRecords(true);
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();

    useSessionStatusStore.setState({ hasSnapshot: true });
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("waits while the status socket is down: the last snapshot may be stale", () => {
    useSessionStatusStore.setState({ isConnected: false });
    mainRecords(true);
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();

    useSessionStatusStore.setState({ isConnected: true });
    expect(desktopBridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the main process records the cancel", async () => {
    working(1, "agent");
    mainRecords(true);
    await useUpdateStore.getState().cancelInstallWhenAgentsFinish();
    expect(desktopBridge.setInstallWhenAgentsFinish).toHaveBeenCalledWith(false);
    mainRecords(false);
    working(1, "idle");
    expect(desktopBridge.installUpdate).not.toHaveBeenCalled();
  });

  it("reports a wish the main process refused", async () => {
    vi.mocked(desktopBridge.setInstallWhenAgentsFinish).mockRejectedValueOnce(
      new Error("No downloaded update to install."),
    );
    await useUpdateStore.getState().scheduleInstallWhenAgentsFinish();
    expect(toastError).toHaveBeenCalledWith(expect.any(Error), "Could not schedule the update.");
    expect(useUpdateStore.getState()).toMatchObject({
      installWhenAgentsFinish: false,
      installWishPending: false,
    });
  });
});
