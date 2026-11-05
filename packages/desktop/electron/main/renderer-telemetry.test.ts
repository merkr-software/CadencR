// @vitest-environment jsdom
// Exercise real ErrorEvent capture through the IPC handler and HTTP relay.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import fixture from "../../src/shared/fixtures/renderer-diagnostic.json";

const state = vi.hoisted(() => ({
  directory: "",
  handlers: new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.16.0",
    getPath: () => state.directory,
    getAppPath: () => state.directory,
  },
  dialog: {},
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown) =>
      state.handlers.set(name, handler),
  },
}));
vi.mock("./runtime-config", () => ({
  getRuntimeConfig: () => ({
    baseUrl: "http://127.0.0.1:5005",
    authToken: "local-test-token",
  }),
}));
vi.mock("@/lib/renderer-diagnostics", () => ({
  recordDiagnosticSuppression: vi.fn(),
  captureDiagnosticContext: () => ({
    schemaVersion: 1,
    reportId: "report",
    sessionId: "session",
    capturedAt: new Date().toISOString(),
    appVersion: "0.16.0",
    buildId: fixture.build_id,
    reactVersion: "19",
    userAgent: "test",
    route: "/",
    viewport: { width: 1, height: 1, scale: 1 },
    uptimeMs: 1,
    duplicatesSuppressed: 0,
    breadcrumbs: [],
  }),
}));
import { installGlobalRendererErrorHandlers } from "../../src/lib/renderer-error-reporting";
import { registerRendererDiagnosticsIpc } from "./renderer-diagnostics-ipc";

afterEach(() => {
  vi.unstubAllGlobals();
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
});

it("carries a stackless thrown primitive from ErrorEvent through IPC to the exact safe wire contract", () => {
  state.directory = mkdtempSync(path.join(os.tmpdir(), "cadencr-telemetry-transport-"));
  const assets = path.join(state.directory, "out/renderer/assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, "index-BtoNKF7I.js"), "");
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const trusted = vi.fn();
  registerRendererDiagnosticsIpc(() => null, trusted);
  const stop = installGlobalRendererErrorHandlers(async (payload) => {
    state.handlers.get("app:renderer-error")!({} as IpcMainInvokeEvent, payload);
  });
  try {
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: "private prompt sk-secret",
        message: "private prompt sk-secret",
        filename: "file:///home/private/app/renderer/assets/index-BtoNKF7I.js",
        lineno: 12,
        colno: 34,
      }),
    );
    expect(trusted).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:5005/api/telemetry/diagnostics");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(fixture);
    expect(fetch.mock.calls[0][1].body).not.toMatch(/private|prompt|sk-secret|file:/);
  } finally {
    stop();
  }
});
