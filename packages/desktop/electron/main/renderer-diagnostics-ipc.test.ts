import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { DiagnosticContext } from "../../src/shared/renderer-diagnostics";

const state = vi.hoisted(() => ({
  directory: "",
  handlers: new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>(),
  save: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.15.0", getPath: () => state.directory },
  dialog: { showSaveDialog: state.save },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown) =>
      state.handlers.set(name, handler),
  },
}));
import { registerRendererDiagnosticsIpc } from "./renderer-diagnostics-ipc";

const context: DiagnosticContext = {
  schemaVersion: 1,
  reportId: "report",
  sessionId: "session",
  capturedAt: new Date(0).toISOString(),
  appVersion: "0.15.0",
  buildId: "exact-build",
  reactVersion: "19.3",
  userAgent: "test",
  route: "/agents",
  viewport: { width: 1000, height: 800, scale: 1 },
  uptimeMs: 100,
  duplicatesSuppressed: 20,
  breadcrumbs: [{ at: 0, kind: "navigation", detail: { route: "/agents" }, count: 1 }],
};
const event = {} as IpcMainInvokeEvent;
const window = {} as BrowserWindow;
const trusted = vi.fn();
const invoke = (channel: string, payload: unknown) => state.handlers.get(channel)!(event, payload);

beforeEach(() => {
  state.directory = mkdtempSync(path.join(os.tmpdir(), "cadencr-diagnostic-ipc-"));
  state.save.mockReset();
  trusted.mockReset();
  state.handlers.clear();
  registerRendererDiagnosticsIpc(() => window, trusted);
});

it("exports persisted reports after a new main-process registration with the original crash context", async () => {
  invoke("app:renderer-error", {
    source: "react-boundary",
    message: "crash",
    stack: "at bundle.js:1:40",
    componentStack: "at AgentPanel",
    diagnostics: context,
  });
  for (let i = 0; i < 30; i++) {
    invoke("app:renderer-error", {
      source: "error",
      message: "ResizeObserver loop completed with undelivered notifications",
      stack: `at layout${i}.js:1:1`,
    });
  }
  expect(readFileSync(path.join(state.directory, "renderer-errors.log"), "utf8")).toContain(
    "at layout0.js:1:1",
  );
  registerRendererDiagnosticsIpc(() => window, trusted);
  const target = path.join(state.directory, "export.json");
  state.save.mockResolvedValue({ canceled: false, filePath: target });
  expect(
    await invoke("app:export-renderer-diagnostics", { ...context, reportId: "export-time" }),
  ).toEqual({ canceled: false });
  const result = JSON.parse(readFileSync(target, "utf8"));
  expect(result.reports).toHaveLength(10);
  expect(result.reports[0].error.diagnostics.reportId).toBe("report");
  expect(result.reports[0].error.componentStack).toBe("at AgentPanel");
  expect(result.current.reportId).toBe("export-time");
  expect(trusted).toHaveBeenCalledTimes(32);
});

it("handles cancellation and rejects an untrusted or malformed export before opening a dialog", async () => {
  state.save.mockResolvedValue({ canceled: true });
  expect(await invoke("app:export-renderer-diagnostics", context)).toEqual({ canceled: true });
  state.save.mockClear();
  await expect(
    invoke("app:export-renderer-diagnostics", { secrets: "not context" }),
  ).rejects.toThrow();
  trusted.mockImplementation(() => {
    throw new Error("Untrusted sender");
  });
  await expect(invoke("app:export-renderer-diagnostics", context)).rejects.toThrow(
    "Untrusted sender",
  );
  expect(state.save).not.toHaveBeenCalled();
});

it("never overwrites an existing file or diagnostic history", async () => {
  const target = path.join(state.directory, "existing.json");
  writeFileSync(target, "SQLite format 3\0preserved database");
  state.save.mockResolvedValue({ canceled: false, filePath: target });
  await expect(invoke("app:export-renderer-diagnostics", context)).rejects.toThrow(
    /unused filename/,
  );
  expect(readFileSync(target, "utf8")).toBe("SQLite format 3\0preserved database");
});

it("preserves corrupt history while still recording the crash in the independent text log", () => {
  const history = path.join(state.directory, "renderer-diagnostics.json");
  writeFileSync(history, "corrupt evidence");
  expect(() =>
    invoke("app:renderer-error", { source: "error", message: "new crash", diagnostics: context }),
  ).toThrow("Could not save all diagnostic files");
  expect(readFileSync(history, "utf8")).toBe("corrupt evidence");
  expect(readFileSync(path.join(state.directory, "renderer-errors.log"), "utf8")).toContain(
    "new crash",
  );
});
