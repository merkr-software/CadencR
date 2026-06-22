import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installRendererCrashRecovery } from "./renderer-crash-recovery";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

interface FakeWebContents {
  on: (event: "render-process-gone", listener: RendererGoneHandler) => void;
  reload: () => void;
}

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: FakeWebContents;
}

type RendererGoneHandler = (event: unknown, details: { reason: string; exitCode: number }) => void;

function fakeWindow(): FakeWindow {
  const on = vi.fn((_event: "render-process-gone", _listener: RendererGoneHandler): void => {});
  const reload = vi.fn((): void => {});
  return {
    isDestroyed: () => false,
    webContents: { on, reload },
  };
}

describe("installRendererCrashRecovery", () => {
  it("logs renderer process exits and reloads the still-open window", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cadencr-renderer-crash-test-"));
    const logPath = path.join(dir, "renderer-crashes.log");
    const win = fakeWindow();

    installRendererCrashRecovery(win, {
      appVersion: "0.6.1",
      logPath,
      maxReloads: 2,
      now: () => new Date("2026-06-22T18:25:29.000Z"),
      platform: "darwin",
      reloadWindowMs: 60_000,
      reportReloadSuppressed: vi.fn(),
      reportWriteFailure: vi.fn(),
    });

    expect(win.webContents.on).toHaveBeenCalledWith("render-process-gone", expect.any(Function));
    const onMock = vi.mocked(win.webContents.on);
    const handler = onMock.mock.calls[0]?.[1];
    expect(handler).toBeDefined();

    handler?.({}, { reason: "crashed", exitCode: 5 });

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("reason: crashed");
    expect(log).toContain("exitCode: 5");
    expect(log).toContain("appVersion: 0.6.1");
    expect(win.webContents.reload).toHaveBeenCalledOnce();
  });

  it("stops auto-reloading after repeated renderer crashes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cadencr-renderer-crash-test-"));
    const win = fakeWindow();
    const reportReloadSuppressed = vi.fn();

    installRendererCrashRecovery(win, {
      appVersion: "0.6.1",
      logPath: path.join(dir, "renderer-crashes.log"),
      maxReloads: 1,
      now: () => new Date("2026-06-22T18:25:29.000Z"),
      platform: "darwin",
      reloadWindowMs: 60_000,
      reportReloadSuppressed,
      reportWriteFailure: vi.fn(),
    });

    const handler = vi.mocked(win.webContents.on).mock.calls[0]?.[1];
    handler?.({}, { reason: "crashed", exitCode: 5 });
    handler?.({}, { reason: "crashed", exitCode: 5 });

    expect(win.webContents.reload).toHaveBeenCalledOnce();
    expect(reportReloadSuppressed).toHaveBeenCalledOnce();
  });
});
