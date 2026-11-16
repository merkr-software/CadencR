import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { CliRendererItem, CliInstallStatus } from "../../src/shared/cli-bridge";
import { MAC_BIN_DIR, type CliInstallContext } from "./cli-install-context";
import { cliInstallStatus, installCli, refreshInstalledCli, uninstallCli } from "./cli-install";
import { CliRequestQueue, handleCliArgv } from "./cli-request-queue";
import { errnoCode } from "./errno";
import { assertTrustedSender } from "./ipc";
import { detectLinuxInstallType } from "./linux-install-type";
import { sendToWindow } from "./safe-send";

/** Main → renderer: requests are waiting; the renderer drains them. */
const CLI_REQUESTS_PENDING_CHANNEL = "cli:requests-pending";

const installOptionsSchema = z.object({ replace: z.boolean() }).strict();

/** osascript's "User canceled." (error -128) when the password prompt is dismissed. */
const USER_CANCELED = /User canceled|\(-128\)/;

function runPrivileged(script: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script, ...args], (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = stderr.trim() || error.message;
      reject(
        new Error(
          USER_CANCELED.test(detail)
            ? "Installation cancelled: administrator access was not granted."
            : `Administrator command failed: ${detail}`,
        ),
      );
    });
  });
}

/** macOS `/etc/paths`: what `path_helper` puts on every login shell's PATH. */
function macLoginPathDirs(): string[] {
  try {
    return fs
      .readFileSync("/etc/paths", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

let context: CliInstallContext | null = null;

/** Built once: nothing in it changes while the app runs (`env` is the live object). */
function productionContext(): CliInstallContext {
  return (context ??= {
    platform: process.platform,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    resourcesPath: process.resourcesPath,
    env: process.env,
    loginPathDirs: process.platform === "darwin" ? macLoginPathDirs() : [],
    homedir: os.homedir(),
    linuxInstallType:
      process.platform === "linux"
        ? detectLinuxInstallType(process.env, path.join(process.resourcesPath, "package-type"))
        : "unknown",
    macBinDir: MAC_BIN_DIR,
    runPrivileged,
  });
}

export interface CliIpcOptions {
  getMainWindow: () => BrowserWindow | null;
}

export interface CliController {
  /** Acts on the request in `argv`; true when there was one (bring the app forward). */
  handleArgv: (argv: readonly string[]) => Promise<boolean>;
  /** AppImage upkeep of the user's copied command; failures reach the renderer. */
  refreshInstalledCommand: () => Promise<void>;
}

/** The `cadencr` command's channels: its requests, and installing it on PATH. */
export function registerCliIpc({ getMainWindow }: CliIpcOptions): CliController {
  const queue = new CliRequestQueue(() =>
    sendToWindow(getMainWindow(), CLI_REQUESTS_PENDING_CHANNEL),
  );
  ipcMain.handle("cli:drain-requests", (event: IpcMainInvokeEvent): CliRendererItem[] => {
    assertTrustedSender(event, getMainWindow);
    return queue.drain();
  });
  ipcMain.handle("cli:install-status", (event: IpcMainInvokeEvent): Promise<CliInstallStatus> => {
    assertTrustedSender(event, getMainWindow);
    return cliInstallStatus(productionContext());
  });
  ipcMain.handle(
    "cli:install",
    (event: IpcMainInvokeEvent, options: unknown): Promise<CliInstallStatus> => {
      assertTrustedSender(event, getMainWindow);
      const parsed = installOptionsSchema.safeParse(options);
      if (!parsed.success) throw new Error("Invalid cadencr command install options.");
      return installCli(productionContext(), parsed.data);
    },
  );
  ipcMain.handle("cli:uninstall", (event: IpcMainInvokeEvent): Promise<CliInstallStatus> => {
    assertTrustedSender(event, getMainWindow);
    return uninstallCli(productionContext());
  });
  return {
    handleArgv: async (argv) => {
      try {
        return await handleCliArgv(argv, queue);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        queue.push({ kind: "error", message: `The cadencr command's request failed: ${detail}` });
        return true;
      }
    },
    refreshInstalledCommand: async () => {
      try {
        await refreshInstalledCli(productionContext());
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[cli] could not refresh the cadencr command: ${detail}`);
        queue.push({ kind: "error", message: `Couldn't update the cadencr command: ${detail}` });
      }
    },
  };
}
