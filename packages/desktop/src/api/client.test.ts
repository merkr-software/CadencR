import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDesktopBridgeOverrideForTests,
  clearDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import {
  __resetRuntimeConfigForTests,
  customInstance,
  getAuthTokenSync,
  preloadRuntimeConfig,
  publicationOperationTimeout,
  managedProviderOperationTimeout,
  resolveApiBaseUrlSync,
  shouldAttachAbortSignal,
  strictModeStableReadRequestKey,
  workspaceSettingFromBulk,
} from "./client";

describe("publication release timeout policy", () => {
  it.each([
    "/api/projects/7/publication-release",
    "/api/projects/42/publication-release/preview",
    "/api/projects/9/publication-contribution",
    "/api/projects/7/publication-registry",
    "/api/projects/42/publication-registry/preview",
  ])("allows the exact POST endpoint to finish its bounded backend work: %s", (url) => {
    expect(publicationOperationTimeout({ method: "POST", url })).toBe(190000);
  });

  it.each([
    { method: "GET", url: "/api/projects/7/publication-release" },
    { method: "POST", url: "/api/projects/not-a-number/publication-release" },
    { method: "POST", url: "/api/projects/7/publication-release/preview/extra" },
    { method: "POST", url: "/api/projects/7/publication-contribution/extra" },
    { method: "POST", url: "/api/projects/7/publication-registry/preview/extra" },
    { method: "POST", url: "/api/projects/7/publication-package" },
  ])("leaves unrelated requests on the Axios default: $method $url", (config) => {
    expect(publicationOperationTimeout(config)).toBeUndefined();
  });

  it("preserves an explicit caller timeout", () => {
    expect(
      publicationOperationTimeout({
        method: "POST",
        timeout: 5000,
        url: "/api/projects/7/publication-release/preview",
      }),
    ).toBe(5000);
  });
});

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
    pickImageFile: vi.fn(),
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
    acknowledgeCloseRequest: vi.fn(() => Promise.resolve()),
    cancelClose: vi.fn(() => Promise.resolve()),
    serviceStatus: vi.fn(() => Promise.resolve({ state: "running" as const })),
    restartService: vi.fn(() => Promise.resolve()),
    onServiceStatus: vi.fn(() => () => undefined),
    setZoom: vi.fn(),
    currentTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    fetchChangelogImage: vi.fn(),
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

  it("uses the fallback base URL without reading the build-time bearer", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:6123/");
    vi.stubEnv("VITE_API_TOKEN", "dev-token");
    const runtimeConfig = vi.fn(() => Promise.reject(new Error("runtime config unavailable")));
    setDesktopBridgeOverrideForTests(bridgeWithRuntime(runtimeConfig));

    await preloadRuntimeConfig();

    expect(resolveApiBaseUrlSync()).toBe("http://127.0.0.1:6123");
    expect(getAuthTokenSync()).toBeNull();
  });

  it("never reads a sidecar bearer even if runtime data or env contains it", async () => {
    vi.stubEnv("VITE_API_TOKEN", "dev-token");
    const runtimeConfig = vi.fn(() =>
      Promise.resolve({ baseUrl: "http://127.0.0.1:5005", authToken: null }),
    );
    setDesktopBridgeOverrideForTests(bridgeWithRuntime(runtimeConfig));

    expect(await preloadRuntimeConfig()).toEqual({ baseUrl: "http://127.0.0.1:5005" });

    expect(resolveApiBaseUrlSync()).toBe("http://127.0.0.1:5005");
    expect(getAuthTokenSync()).toBeNull();
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

describe("managed provider timeout policy", () => {
  it.each([
    "/api/agents/managed-providers",
    "/api/agents/managed-providers/example/update",
    "/api/agents/managed-providers/example/rollback",
  ])("allows bounded download and conformance: %s", (url) => {
    expect(managedProviderOperationTimeout({ method: "POST", url })).toBe(180000);
  });
  it.each([
    { method: "GET", url: "/api/agents/managed-providers" },
    { method: "POST", url: "/api/agents/managed-providers/catalog/refresh" },
    { method: "PUT", url: "/api/agents/managed-providers/example/enabled" },
    { method: "POST", url: "/api/agents/managed-providers/example/update/extra" },
  ])("does not change unrelated requests", (config) => {
    expect(managedProviderOperationTimeout(config)).toBeUndefined();
  });
  it("preserves explicit timeout", () => {
    expect(
      managedProviderOperationTimeout({
        method: "POST",
        url: "/api/agents/managed-providers",
        timeout: 5000,
      }),
    ).toBe(5000);
  });
});

describe("workspace settings bulk cache", () => {
  function respond(config: InternalAxiosRequestConfig, data: unknown) {
    return { data, status: 200, statusText: "OK", headers: {}, config };
  }

  it("never caches a bulk read that raced a settings write", async () => {
    let releaseStaleRead: () => void = () => undefined;
    const staleRead: AxiosAdapter = (config) =>
      new Promise((resolve) => {
        releaseStaleRead = () =>
          resolve(respond(config, [{ key: "sidebar_density", value: "compact" }]));
      });
    const bulk = customInstance({ url: "/api/workspace/settings", adapter: staleRead });
    await customInstance({
      url: "/api/workspace/settings",
      method: "PUT",
      adapter: async (config) => respond(config, []),
    });
    releaseStaleRead();
    await bulk;

    const fresh = vi.fn<AxiosAdapter>(async (config) => respond(config, { value: "spacious" }));
    await expect(
      customInstance({ url: "/api/workspace/settings/sidebar_density", adapter: fresh }),
    ).resolves.toEqual({ value: "spacious" });
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe("blob error bodies", () => {
  it("decodes a blob request's JSON error body so the service's reason survives", async () => {
    const body = { error: "Not found: /tmp/qa/gone.png", code: "NOT_FOUND" };
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", config, null, {
        data: new Blob([JSON.stringify(body)], { type: "application/json" }),
        status: 404,
        statusText: "Not Found",
        headers: {},
        config,
      });
    };

    const error = await customInstance({ url: "/api/x", responseType: "blob", adapter }).catch(
      (caught: unknown) => caught,
    );

    expect(apiErrorMessage(error, "fallback")).toBe(body.error);
    expect(apiErrorCode(error)).toBe("NOT_FOUND");
  });
});
