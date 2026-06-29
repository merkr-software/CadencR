import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDesktopBridgeOverrideForTests,
  clearDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import {
  __resetRuntimeConfigForTests,
  getAuthTokenSync,
  preloadRuntimeConfig,
  resolveApiBaseUrlSync,
  shouldAttachAbortSignal,
  strictModeStableReadRequestKey,
  workspaceSettingFromBulk,
} from "./client";

function bridgeWithRuntime(
  runtimeConfig: CadencrDesktopBridge["runtimeConfig"],
): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig,
    readFileBase64: vi.fn(),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(),
    showSaveDialog: vi.fn(),
    notifyPermission: vi.fn(),
    notify: vi.fn(),
    notifyTest: vi.fn(),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: vi.fn(() => () => undefined),
    onNotificationFallback: vi.fn(() => () => undefined),
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

describe("runtime config client", () => {
  beforeEach(() => {
    __resetRuntimeConfigForTests();
    vi.unstubAllEnvs();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clearDesktopBridgeOverrideForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearDesktopBridgeOverrideForTests();
  });

  it("falls back to env base URL and token when runtime config is unavailable", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:6123/");
    vi.stubEnv("VITE_API_TOKEN", "dev-token");
    const runtimeConfig = vi.fn(() => Promise.reject(new Error("runtime config unavailable")));
    setDesktopBridgeOverrideForTests(bridgeWithRuntime(runtimeConfig));

    await preloadRuntimeConfig();

    expect(resolveApiBaseUrlSync()).toBe("http://127.0.0.1:6123");
    expect(getAuthTokenSync()).toBe("dev-token");
  });

  it("coalesces a missing runtime auth token with the env fallback", async () => {
    vi.stubEnv("VITE_API_TOKEN", "dev-token");
    const runtimeConfig = vi.fn(() =>
      Promise.resolve({ baseUrl: "http://127.0.0.1:5005", authToken: null }),
    );
    setDesktopBridgeOverrideForTests(bridgeWithRuntime(runtimeConfig));

    await preloadRuntimeConfig();

    expect(resolveApiBaseUrlSync()).toBe("http://127.0.0.1:5005");
    expect(getAuthTokenSync()).toBe("dev-token");
  });
});

describe("request abort policy", () => {
  it("keeps StrictMode-stable read endpoints alive across development remounts", () => {
    const signal = new AbortController().signal;

    expect(shouldAttachAbortSignal({ method: "GET", signal, url: "/api/git/diff" })).toBe(false);
    expect(shouldAttachAbortSignal({ method: "GET", signal, url: "/api/feature-layouts" })).toBe(
      false,
    );
  });

  it("preserves abort signals for mutations and large message fetches", () => {
    const signal = new AbortController().signal;

    expect(shouldAttachAbortSignal({ method: "POST", signal, url: "/api/git/commit" })).toBe(true);
    expect(
      shouldAttachAbortSignal({
        method: "GET",
        signal,
        url: "/api/sessions/messages/2585/full",
      }),
    ).toBe(true);
  });
});

describe("stable read request key", () => {
  it("normalizes equivalent query param insertion orders", () => {
    expect(
      strictModeStableReadRequestKey({
        method: "GET",
        url: "/api/git/diff",
        params: { feature_id: 1076, mode: "uncommitted" },
      }),
    ).toBe(
      strictModeStableReadRequestKey({
        method: "GET",
        url: "/api/git/diff",
        params: { mode: "uncommitted", feature_id: 1076 },
      }),
    );
  });

  it("does not dedupe non-stable reads", () => {
    expect(
      strictModeStableReadRequestKey({
        method: "GET",
        url: "/api/sessions/messages/2585/full",
      }),
    ).toBeNull();
  });
});

describe("workspace setting bulk adapter", () => {
  it("projects a single setting response from the bulk workspace settings payload", () => {
    expect(
      workspaceSettingFromBulk(
        [
          { key: "loader_style", value: "spinner" },
          { key: "sidebar_collapsed", value: "false" },
        ],
        "sidebar_collapsed",
      ),
    ).toEqual({ value: "false" });
  });

  it("returns null for missing settings and ignores malformed payloads", () => {
    expect(workspaceSettingFromBulk([{ key: "known", value: "yes" }], "missing")).toEqual({
      value: null,
    });
    expect(workspaceSettingFromBulk({ key: "known", value: "yes" }, "known")).toBeUndefined();
  });
});
