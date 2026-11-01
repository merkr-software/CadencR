import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createDiagnosticGate,
  diagnosticContextSchema,
  rendererErrorSchema,
  type DiagnosticRecord,
} from "../../src/shared/renderer-diagnostics";
import { rendererRemoteDiagnostic } from "../../src/shared/telemetry-diagnostics";
import {
  relayRemoteDiagnostic,
  rendererTelemetryAssets,
  telemetryRelayStatus,
} from "./telemetry-relay";
import { resolveRendererDiagnosticHistory } from "./app-paths";
import { appendRendererErrorLog } from "./renderer-error-log";
import { readDiagnosticRecords, saveDiagnosticRecord } from "./renderer-diagnostics-store";

export function registerRendererDiagnosticsIpc(
  getMainWindow: () => BrowserWindow | null,
  assertTrusted: (event: IpcMainInvokeEvent) => void,
): void {
  const gate = createDiagnosticGate();
  ipcMain.handle("app:telemetry-relay-status", (event) => {
    assertTrusted(event);
    return telemetryRelayStatus();
  });
  const historyPath = () =>
    resolveRendererDiagnosticHistory(app.isPackaged, app.getPath("userData"));
  ipcMain.handle("app:renderer-error", (event, payload: unknown) => {
    assertTrusted(event);
    const error = rendererErrorSchema.parse(payload);
    if (!gate.accept(error)) return;
    relayRemoteDiagnostic(rendererRemoteDiagnostic(error, rendererTelemetryAssets()));
    const record: DiagnosticRecord = {
      timestamp: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron ?? "unknown",
      chrome: process.versions.chrome ?? "unknown",
      error,
    };
    const failures: unknown[] = [];
    for (const persist of [
      () => saveDiagnosticRecord(historyPath(), record),
      () =>
        appendRendererErrorLog(error, {
          appVersion: record.appVersion,
          platform: record.platform,
          logPath: path.join(app.getPath("logs"), "renderer-errors.log"),
          now: () => new Date(record.timestamp),
        }),
    ]) {
      try {
        persist();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Could not save all diagnostic files");
  });
  ipcMain.handle("app:export-renderer-diagnostics", async (event, rawContext: unknown) => {
    assertTrusted(event);
    const current = diagnosticContextSchema.parse(rawContext);
    const reports = readDiagnosticRecords(historyPath());
    const window = getMainWindow();
    if (!window) throw new Error("The application window is unavailable");
    const selected = await dialog.showSaveDialog(window, {
      title: "Export diagnostic report",
      defaultPath: `cadencr-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      filters: [{ name: "Diagnostic report", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    if (
      !selected.filePath.endsWith(".json") ||
      path.resolve(selected.filePath) === path.resolve(historyPath())
    ) {
      throw new Error("Choose a new .json file for the diagnostic export");
    }
    try {
      await writeFile(
        selected.filePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            current,
            reports,
          },
          null,
          2,
        ),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Choose an unused filename for the diagnostic report", { cause: error });
      }
      throw error;
    }
    return { canceled: false };
  });
}
