import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setDesktopBridgeOverrideForTests,
  clearDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import {
  AxiosError,
  CanceledError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from "axios";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import {
  __resetRuntimeConfigForTests,
  __resetStableReadRequestsForTests,
  customInstance,
  getAuthTokenSync,
  preloadRuntimeConfig,
  publicationOperationTimeout,
  managedProviderOperationTimeout,
  resolveApiBaseUrlSync,
  strictModeStableReadRequestKey,
  workspaceSettingFromBulk,
} from "./client";
import { executeStableReadRequest, STRICT_MODE_ABORT_GRACE_MS } from "./stable-read-requests";

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
    setInterfaceLanguage: vi.fn().mockResolvedValue(undefined),
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
    checkForUpdates: vi.fn(),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    fetchChangelogImage: vi.fn(),
    installUpdate: vi.fn(() => Promise.resolve()),
    setInstallWhenAgentsFinish: vi.fn(),
    getUpdateState: vi.fn(),
    onUpdateState: vi.fn(() => () => undefined),
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
      Promise.resolve({
        baseUrl: "http://127.0.0.1:5005",
        preferredLanguages: ["fr", "en"],
        authToken: "main-only",
      }),
    );
    setDesktopBridgeOverrideForTests(bridgeWithRuntime(runtimeConfig));

    expect(await preloadRuntimeConfig()).toStrictEqual({
      baseUrl: "http://127.0.0.1:5005",
      preferredLanguages: ["fr", "en"],
    });

    expect(resolveApiBaseUrlSync()).toBe("http://127.0.0.1:5005");
    expect(getAuthTokenSync()).toBeNull();
  });
});

describe("stable read request cancellation and StrictMode reuse", () => {
  beforeEach(() => {
    __resetStableReadRequestsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetStableReadRequestsForTests();
  });

  it("reuses an in-flight GET across a StrictMode unmount/remount within the grace window", async () => {
    vi.useFakeTimers();
    let resolveBackend: ((value: { ok: boolean }) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      (config) =>
        new Promise<{ ok: boolean }>((resolve) => {
          capturedSignal = config.signal as AbortSignal;
          resolveBackend = resolve;
        }),
    );

    const mount1 = new AbortController();
    const first = executeStableReadRequest(
      "GET /api/git/status?1",
      { method: "GET", url: "/api/git/status", signal: mount1.signal },
      execute,
      { graceMs: STRICT_MODE_ABORT_GRACE_MS, resultTtlMs: 250 },
    );

    // StrictMode unmount aborts the first observer.
    mount1.abort();
    await expect(first).rejects.toBeInstanceOf(CanceledError);
    expect(capturedSignal?.aborted).toBe(false);

    // StrictMode remount subscribes before the grace timer fires.
    vi.advanceTimersByTime(10);
    const mount2 = new AbortController();
    const second = executeStableReadRequest(
      "GET /api/git/status?1",
      { method: "GET", url: "/api/git/status", signal: mount2.signal },
      execute,
      { graceMs: STRICT_MODE_ABORT_GRACE_MS, resultTtlMs: 250 },
    );

    // Passing the original grace deadline must NOT abort because mount2 is attached.
    vi.advanceTimersByTime(STRICT_MODE_ABORT_GRACE_MS * 2);
    expect(capturedSignal?.aborted).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveBackend?.({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("aborts the underlying request after the DEV grace window when no remount arrives", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      (config) =>
        new Promise<unknown>((_resolve, reject) => {
          capturedSignal = config.signal as AbortSignal;
          capturedSignal.addEventListener("abort", () => reject(new CanceledError("aborted")));
        }),
    );

    const controller = new AbortController();
    const promise = executeStableReadRequest(
      "GET /api/git/diff?42",
      { method: "GET", url: "/api/git/diff", signal: controller.signal },
      execute,
      { graceMs: STRICT_MODE_ABORT_GRACE_MS, resultTtlMs: 250 },
    );

    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CanceledError);
    expect(capturedSignal?.aborted).toBe(false);

    vi.advanceTimersByTime(STRICT_MODE_ABORT_GRACE_MS);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("aborts the underlying request immediately in production (graceMs = 0)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      (config) =>
        new Promise<unknown>((_resolve, reject) => {
          capturedSignal = config.signal as AbortSignal;
          capturedSignal.addEventListener("abort", () => reject(new CanceledError("aborted")));
        }),
    );

    const controller = new AbortController();
    const promise = executeStableReadRequest(
      "GET /api/git/file-diff?7",
      { method: "GET", url: "/api/git/file-diff", signal: controller.signal },
      execute,
      { graceMs: 0, resultTtlMs: 0 },
    );

    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(CanceledError);
  });

  it("keeps a shared request alive until all subscribers abort", async () => {
    let resolveBackend: ((value: string) => void) | undefined;
    let capturedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      (config) =>
        new Promise<string>((resolve, reject) => {
          capturedSignal = config.signal as AbortSignal;
          capturedSignal.addEventListener("abort", () => reject(new CanceledError("aborted")));
          resolveBackend = resolve;
        }),
    );

    const sub1 = new AbortController();
    const sub2 = new AbortController();
    const p1 = executeStableReadRequest(
      "GET /api/git/status?99",
      { method: "GET", url: "/api/git/status", signal: sub1.signal },
      execute,
      { graceMs: 0, resultTtlMs: 0 },
    );
    const p2 = executeStableReadRequest(
      "GET /api/git/status?99",
      { method: "GET", url: "/api/git/status", signal: sub2.signal },
      execute,
      { graceMs: 0, resultTtlMs: 0 },
    );
    expect(execute).toHaveBeenCalledTimes(1);

    sub1.abort();
    await expect(p1).rejects.toBeInstanceOf(CanceledError);
    expect(capturedSignal?.aborted).toBe(false);

    resolveBackend?.("clean");
    await expect(p2).resolves.toBe("clean");
  });

  it("cancels an actual customInstance GET /api/git/* request when aborted", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const adapter: AxiosAdapter = (config) =>
      new Promise((_resolve, reject) => {
        capturedSignal = config.signal as AbortSignal;
        capturedSignal.addEventListener("abort", () => reject(new CanceledError("aborted")));
      });

    const controller = new AbortController();
    const request = customInstance({
      method: "GET",
      url: "/api/git/file-diff",
      params: { feature_id: 55, file_path: "huge.ts" },
      signal: controller.signal,
      adapter,
    });

    controller.abort();
    await expect(request).rejects.toBeInstanceOf(CanceledError);
    vi.advanceTimersByTime(STRICT_MODE_ABORT_GRACE_MS);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("rejects immediately when given a pre-aborted signal without calling execute", async () => {
    const execute = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeStableReadRequest(
        "GET /api/git/status?preaborted",
        { method: "GET", url: "/api/git/status", signal: controller.signal },
        execute,
        { graceMs: 0, resultTtlMs: 0 },
      ),
    ).rejects.toBeInstanceOf(CanceledError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("evicts cached DEV stable read results automatically after resultTtlMs", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => ({ diff: "large-payload" }));

    const first = await executeStableReadRequest(
      "GET /api/git/diff?ttl",
      { method: "GET", url: "/api/git/diff" },
      execute,
      { graceMs: 0, resultTtlMs: 250 },
    );
    expect(first).toEqual({ diff: "large-payload" });
    expect(vi.getTimerCount()).toBe(1);

    // Within TTL, replays the cached result without re-invoking execute.
    await expect(
      executeStableReadRequest(
        "GET /api/git/diff?ttl",
        { method: "GET", url: "/api/git/diff" },
        execute,
        { graceMs: 0, resultTtlMs: 250 },
      ),
    ).resolves.toEqual({ diff: "large-payload" });
    expect(execute).toHaveBeenCalledTimes(1);

    // After TTL elapses, eviction timer clears the cached payload automatically.
    vi.advanceTimersByTime(250);
    expect(vi.getTimerCount()).toBe(0);

    await executeStableReadRequest(
      "GET /api/git/diff?ttl",
      { method: "GET", url: "/api/git/diff" },
      execute,
      { graceMs: 0, resultTtlMs: 250 },
    );
    expect(execute).toHaveBeenCalledTimes(2);
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

  it("checks the language invitation with the service even when bulk settings are cached", async () => {
    await customInstance({
      url: "/api/workspace/settings",
      adapter: async (config) => respond(config, [{ key: "ui_language", value: "legacy-english" }]),
    });
    const fresh = vi.fn<AxiosAdapter>(async (config) => respond(config, { value: "de-DE" }));
    await expect(
      customInstance({ url: "/api/workspace/settings/ui_language", adapter: fresh }),
    ).resolves.toEqual({ value: "de-DE" });
    expect(fresh).toHaveBeenCalledOnce();
  });

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
