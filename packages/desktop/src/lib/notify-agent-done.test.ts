import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const mockToastError = vi.hoisted(() => vi.fn());
const mockToastMessage = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: mockToastError, message: mockToastMessage } }));

// `notifyAgentDone` fetches the agent's latest-reply preview for the body.
// Partial-mock the generated client so the real query-key helpers stay intact.
const mockGetMessagePreview = vi.hoisted(() => vi.fn());
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  getMessagePreview: mockGetMessagePreview,
}));

// Hash history: `isViewingFeature` parses `window.location.hash`, so drive the
// route by stubbing the hash (`pathname` is always `/` under hash history).
function setRoute(pathname: string): void {
  Object.defineProperty(window, "location", {
    value: { hash: pathname === "/" ? "" : `#${pathname}` },
    writable: true,
  });
}

import { queryClient } from "@/lib/queryClient";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { getGetWorkspaceSettingQueryKey, type SettingValueResponse } from "@/api/generated";
import { NOTIFICATION_MODE_KEY } from "@/lib/notification-mode";
import {
  initNotificationPermission,
  listenForNotificationFailures,
  listenForNotificationFallbacks,
  notifyAgentDone,
  notifyAgentNeedsInput,
  readNotificationMode,
} from "./notify-agent-done";

function setStoredMode(value: string | undefined): void {
  const key = getGetWorkspaceSettingQueryKey(NOTIFICATION_MODE_KEY);
  if (value === undefined) {
    queryClient.removeQueries({ queryKey: key });
  } else {
    queryClient.setQueryData<SettingValueResponse>(key, { value });
  }
}

const mockNotifyPermission = vi.fn();
const mockNotify = vi.fn();
const mockOnNotificationFailed = vi.fn<CadencrDesktopBridge["onNotificationFailed"]>(
  () => () => undefined,
);
const mockOnNotificationFallback = vi.fn<CadencrDesktopBridge["onNotificationFallback"]>(
  () => () => undefined,
);

function bridge(): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(),
    readFileBase64: vi.fn(),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(),
    pickImageFile: vi.fn(),
    showSaveDialog: vi.fn(),
    notifyPermission: mockNotifyPermission,
    notify: mockNotify,
    notifyTest: vi.fn(),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: mockOnNotificationFailed,
    onNotificationFallback: mockOnNotificationFallback,
    onCloseRequested: vi.fn(() => () => undefined),
    confirmClose: vi.fn(),
    requestQuit: vi.fn(),
    setZoom: vi.fn(),
    currentTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

const baseOpts = { featureId: 1, projectId: 2, routeType: "session" as const };

beforeEach(() => {
  vi.clearAllMocks();
  setDesktopBridgeOverrideForTests(bridge());
  setStoredMode("native");
  // Default: no preview available → body falls back to the feature title.
  mockGetMessagePreview.mockResolvedValue({ preview: null });
});

afterEach(() => {
  vi.useRealTimers();
  clearDesktopBridgeOverrideForTests();
  setStoredMode(undefined);
});

describe("initNotificationPermission", () => {
  it("caches the permission result", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    await initNotificationPermission();
    expect(mockNotifyPermission).toHaveBeenCalled();
  });
});

describe("notifyAgentDone", () => {
  it("does not send when permission is not granted", async () => {
    mockNotifyPermission.mockResolvedValue(false);
    await initNotificationPermission();
    mockNotify.mockClear();

    notifyAgentDone({ status: "completed", featureTitle: "My Feature", ...baseOpts });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("sends when user is on a legacy project feature page", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/projects/2/features/1");

    notifyAgentDone({ status: "completed", featureTitle: "My Feature", ...baseOpts });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🟢 | My Feature",
        body: "My Feature",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });

  it("does not send when user is on the session page", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/ws-session/ws-feature-1");

    notifyAgentDone({
      status: "completed",
      featureTitle: "My Feature",
      featureId: 1,
      projectId: 2,
      routeType: "session",
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("sends notification when user is on a different page", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/projects/2/features/99");

    notifyAgentDone({
      status: "completed",
      featureTitle: "My Feature",
      ...baseOpts,
    });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🟢 | My Feature",
        body: "My Feature",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });

  it("uses error title for error status", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/other");

    notifyAgentDone({
      status: "error",
      featureTitle: "Broken Feature",
      ...baseOpts,
    });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🔴 | Broken Feature",
        body: "Broken Feature",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });

  it("uses awaiting title for needs_input status", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/other");

    notifyAgentDone({ status: "needs_input", featureTitle: "Waiting Feature", ...baseOpts });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🟠 | Waiting Feature",
        body: "Waiting Feature",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });

  it("uses the agent's latest reply as the body when available", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    mockGetMessagePreview.mockResolvedValue({ preview: "Refactored the auth module." });
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/other");

    notifyAgentDone({ status: "completed", featureTitle: "My Feature", ...baseOpts });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🟢 | My Feature",
        body: "Refactored the auth module.",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });

  it("falls back to the feature title when there is no reply preview", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    mockGetMessagePreview.mockResolvedValue({ preview: null });
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/other");

    notifyAgentDone({ status: "completed", featureTitle: "My Feature", ...baseOpts });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "🟢 | My Feature", body: "My Feature" }),
      ),
    );
  });
});

describe("listenForNotificationFailures", () => {
  it("toasts the failure reason from the main process and cleans up the listener", () => {
    const cleanup = vi.fn();
    type FailureCb = (payload: { reason: string }) => void;
    const captured: FailureCb[] = [];
    mockOnNotificationFailed.mockImplementationOnce((cb) => {
      captured.push(cb);
      return cleanup;
    });

    const unsubscribe = listenForNotificationFailures();
    expect(captured).toHaveLength(1);

    captured[0]({ reason: "macOS denied authorization" });
    expect(mockToastError).toHaveBeenCalledWith("System notification was blocked", {
      description: "macOS denied authorization",
    });

    unsubscribe();
    expect(cleanup).toHaveBeenCalled();
  });
});

describe("notification mode from query cache", () => {
  async function setup(): Promise<void> {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();
    setRoute("/other");
  }
  const opts = { status: "completed" as const, featureTitle: "F", ...baseOpts };

  it("skips the bridge entirely when the stored mode is 'off'", async () => {
    await setup();
    setStoredMode("off");
    notifyAgentDone(opts);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("forwards the current mode through the bridge payload and reacts to cache changes", async () => {
    await setup();
    setStoredMode("in_app");
    notifyAgentDone(opts);
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "in_app" })),
    );

    setStoredMode("native");
    notifyAgentDone(opts);
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "native" })),
    );
  });

  it("readNotificationMode defaults when no value is cached", () => {
    setStoredMode(undefined);
    expect(readNotificationMode()).toBe("native");
  });
});

describe("listenForNotificationFallbacks", () => {
  it("renders a toast with an Open action that routes through navigate", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    type FallbackCb = Parameters<CadencrDesktopBridge["onNotificationFallback"]>[0];
    const captured: FallbackCb[] = [];
    mockOnNotificationFallback.mockImplementationOnce((cb) => {
      captured.push(cb);
      return cleanup;
    });

    const navigate = vi.fn().mockResolvedValue(undefined);
    const queryClient = { getQueriesData: vi.fn(() => []) } as unknown as Parameters<
      typeof listenForNotificationFallbacks
    >[1];

    const unsubscribe = listenForNotificationFallbacks(navigate, queryClient);
    expect(captured).toHaveLength(1);

    captured[0]({
      title: "🟢 | My Feature",
      body: "Refactored the auth module.",
      click: { feature_id: 9, project_id: 2, route_type: "session" },
    });

    expect(mockToastMessage).toHaveBeenCalledWith(
      "🟢 | My Feature",
      expect.objectContaining({
        description: "Refactored the auth module.",
        action: expect.objectContaining({ label: "Open" }),
      }),
    );

    const action = mockToastMessage.mock.calls[0][1].action as { onClick: () => void };
    action.onClick();
    expect(navigate).toHaveBeenCalledWith({
      to: "/ws-session/$sessionId",
      params: { sessionId: "ws-feature-9" },
      search: { cwd: "", featureId: 9, projectId: 2 },
    });
    await vi.runAllTimersAsync();

    unsubscribe();
    expect(cleanup).toHaveBeenCalled();
  });

  it("renders a toast with no action when there is no click payload (test notification)", () => {
    type FallbackCb = Parameters<CadencrDesktopBridge["onNotificationFallback"]>[0];
    const captured: FallbackCb[] = [];
    mockOnNotificationFallback.mockImplementationOnce((cb) => {
      captured.push(cb);
      return () => undefined;
    });

    const navigate = vi.fn();
    const queryClient = { getQueriesData: vi.fn(() => []) } as unknown as Parameters<
      typeof listenForNotificationFallbacks
    >[1];

    listenForNotificationFallbacks(navigate, queryClient);
    captured[0]({ title: "Test", body: "Hi", click: null });

    expect(mockToastMessage).toHaveBeenCalledWith(
      "Test",
      expect.objectContaining({ description: "Hi", action: undefined }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("notifyAgentNeedsInput", () => {
  it("sends a needs_input notification", async () => {
    mockNotifyPermission.mockResolvedValue(true);
    mockNotify.mockResolvedValue(undefined);
    await initNotificationPermission();
    mockNotify.mockClear();

    setRoute("/other");

    notifyAgentNeedsInput({ featureTitle: "My Feature", ...baseOpts });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith({
        title: "🟠 | My Feature",
        body: "My Feature",
        featureId: 1,
        projectId: 2,
        routeType: "session",
        mode: "native",
      }),
    );
  });
});
