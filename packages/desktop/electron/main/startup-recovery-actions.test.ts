import { clipboard, dialog } from "electron";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./ipc";
import { LATEST_RELEASE_URL, handleStartupRecoveryAction } from "./startup-recovery-actions";
import type { SplashHandle } from "./splash";
import type { StartupRecoveryState } from "./startup-recovery";

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock("./ipc", () => ({
  openExternal: vi.fn(),
}));

const actions: StartupRecoveryState["actions"] = [
  { id: "download_latest", label: "Download latest Cadencr", primary: true },
  { id: "copy_diagnostics", label: "Copy diagnostics" },
  { id: "quit", label: "Quit" },
];

function recoveryState(overrides: Partial<StartupRecoveryState> = {}): StartupRecoveryState {
  return {
    title: "Cadencr couldn't start",
    detail: "Startup failed.",
    actions,
    diagnostics: "diagnostics",
    backup: null,
    dbPath: null,
    ...overrides,
  };
}

function splashHandle(): SplashHandle {
  return {
    window: {} as SplashHandle["window"],
    setPhase: vi.fn(),
    setError: vi.fn(),
    close: vi.fn(),
    onUserClose: vi.fn(),
    onAction: vi.fn(),
  };
}

describe("handleStartupRecoveryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the latest-release URL through the shared external URL policy", async () => {
    vi.mocked(openExternal).mockResolvedValue(undefined);

    await handleStartupRecoveryAction({
      action: "download_latest",
      recovery: recoveryState(),
      splash: splashHandle(),
      quit: vi.fn(),
    });

    expect(openExternal).toHaveBeenCalledWith(LATEST_RELEASE_URL);
  });

  it("surfaces recovery action failures on the splash", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("blocked"));
    const splash = splashHandle();
    const recovery = recoveryState();

    await handleStartupRecoveryAction({
      action: "download_latest",
      recovery,
      splash,
      quit: vi.fn(),
    });

    expect(splash.setError).toHaveBeenCalledWith(
      recovery.title,
      "Recovery action failed: blocked",
      recovery.actions,
    );
  });

  it("copies diagnostics to the clipboard", async () => {
    const splash = splashHandle();
    const recovery = recoveryState();

    await handleStartupRecoveryAction({
      action: "copy_diagnostics",
      recovery,
      splash,
      quit: vi.fn(),
    });

    expect(clipboard.writeText).toHaveBeenCalledWith("diagnostics");
    expect(splash.setError).toHaveBeenCalledWith(
      recovery.title,
      "Diagnostics copied to clipboard.",
      recovery.actions,
    );
  });

  it("confirms and restores a backup over the recorded database path", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const dir = mkdtempSync(path.join(tmpdir(), "cadencr-restore-action-test-"));
    const dbPath = path.join(dir, "cadencr.db");
    const backupPath = path.join(dir, "backup.cadencr.backup.db");
    writeFileSync(dbPath, "broken");
    writeFileSync(backupPath, "backup");
    const splash = splashHandle();
    const recovery = recoveryState({
      backup: { path: backupPath, modifiedMs: 1 },
      dbPath,
      actions: [{ id: "restore_backup", label: "Restore backup…", danger: true }],
    });

    await handleStartupRecoveryAction({
      action: "restore_backup",
      recovery,
      splash,
      quit: vi.fn(),
    });

    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(readFileSync(dbPath, "utf8")).toBe("backup");
  });
});
