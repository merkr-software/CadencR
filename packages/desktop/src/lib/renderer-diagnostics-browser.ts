import {
  diagnosticRecordsSchema,
  retainDiagnosticRecord,
  rendererErrorSchema,
  type DiagnosticContext,
  type DiagnosticRecord,
} from "@/shared/renderer-diagnostics";
import type { RendererErrorReportPayload } from "@/shared/renderer-error";
import { downloadJsonFile } from "./download";

const KEY = "cadencr:renderer-diagnostics:v1";

function readRecords(): DiagnosticRecord[] {
  const raw = localStorage.getItem(KEY);
  return raw ? diagnosticRecordsSchema.parse(JSON.parse(raw)) : [];
}

export async function persistBrowserDiagnostic(payload: RendererErrorReportPayload): Promise<void> {
  const error = rendererErrorSchema.parse(payload);
  const record: DiagnosticRecord = {
    timestamp: new Date().toISOString(),
    appVersion: error.diagnostics?.appVersion ?? "unknown",
    platform: "browser",
    arch: "unknown",
    electron: "none",
    chrome: "unknown",
    error,
  };
  localStorage.setItem(KEY, JSON.stringify(retainDiagnosticRecord(readRecords(), record)));
}

export async function exportBrowserDiagnostics(
  current: DiagnosticContext,
): Promise<{ canceled: boolean }> {
  const report = JSON.stringify(
    { schemaVersion: 1, exportedAt: new Date().toISOString(), current, reports: readRecords() },
    null,
    2,
  );
  downloadJsonFile(`cadencr-diagnostics-${Date.now()}.json`, report);
  return { canceled: false };
}
