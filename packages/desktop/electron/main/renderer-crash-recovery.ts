import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";

interface RendererGoneDetails {
  reason: string;
  exitCode: number;
}

interface ReloadableWebContents {
  on: (
    event: "render-process-gone",
    listener: (event: unknown, details: RendererGoneDetails) => void,
  ) => void;
  reload: () => void;
}

interface RendererCrashWindow {
  isDestroyed: () => boolean;
  webContents: ReloadableWebContents;
}

export interface RendererCrashRecoveryOptions {
  appVersion: string;
  logPath: string;
  maxReloads: number;
  now: () => Date;
  platform: NodeJS.Platform | string;
  reloadWindowMs: number;
  reportReloadSuppressed: (message: string) => void;
  reportWriteFailure: (message: string) => void;
}

export function installDefaultRendererCrashRecovery(window: RendererCrashWindow): void {
  installRendererCrashRecovery(window, {
    appVersion: app.getVersion(),
    logPath: path.join(app.getPath("logs"), "renderer-crashes.log"),
    maxReloads: 2,
    now: () => new Date(),
    platform: process.platform,
    reloadWindowMs: 60_000,
    reportReloadSuppressed: (message) =>
      dialog.showErrorBox("Cadencr renderer crashed repeatedly", message),
    reportWriteFailure: (message) =>
      dialog.showErrorBox("Cadencr renderer diagnostics failed", message),
  });
}

export function installRendererCrashRecovery(
  window: RendererCrashWindow,
  options: RendererCrashRecoveryOptions,
): void {
  const reloads: number[] = [];
  window.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    const now = options.now();
    const diagnostics = buildRendererCrashDiagnostics(details, options);
    try {
      appendRendererCrashDiagnostics(options.logPath, diagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.reportWriteFailure(`Could not write renderer crash diagnostics: ${message}`);
    }
    if (window.isDestroyed()) return;
    const reloadCutoff = now.getTime() - options.reloadWindowMs;
    while (reloads.length > 0 && reloads[0] < reloadCutoff) reloads.shift();
    if (reloads.length >= options.maxReloads) {
      options.reportReloadSuppressed(
        "Cadencr stopped auto-reloading after repeated renderer crashes.",
      );
      return;
    }
    reloads.push(now.getTime());
    window.webContents.reload();
  });
}

function appendRendererCrashDiagnostics(logPath: string, diagnostics: string): void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, diagnostics, "utf8");
}

function buildRendererCrashDiagnostics(
  details: RendererGoneDetails,
  options: RendererCrashRecoveryOptions,
): string {
  return [
    "Cadencr renderer process exited",
    `timestamp: ${options.now().toISOString()}`,
    `appVersion: ${options.appVersion}`,
    `platform: ${options.platform}`,
    `reason: ${details.reason}`,
    `exitCode: ${details.exitCode}`,
    "",
  ].join("\n");
}
