import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { rendererErrorSchema } from "../../src/shared/renderer-diagnostics";
import type { RendererErrorReportPayload } from "../../src/shared/renderer-error";

interface RendererErrorLogOptions {
  appVersion: string;
  logPath: string;
  now: () => Date;
  platform: NodeJS.Platform | string;
}

export function appendRendererErrorLog(
  rawPayload: unknown,
  options: RendererErrorLogOptions,
): void {
  const payload = rendererErrorSchema.parse(rawPayload);
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  if (existsSync(options.logPath) && statSync(options.logPath).size > 2 * 1024 * 1024) {
    renameSync(options.logPath, `${options.logPath}.1`);
  }
  appendFileSync(options.logPath, buildRendererErrorLog(payload, options), "utf8");
}

function buildRendererErrorLog(
  payload: RendererErrorReportPayload,
  options: RendererErrorLogOptions,
): string {
  return [
    "Cadencr renderer error",
    `timestamp: ${options.now().toISOString()}`,
    `appVersion: ${options.appVersion}`,
    `platform: ${options.platform}`,
    `source: ${payload.source}`,
    `message: ${payload.message}`,
    `url: ${payload.url ?? "unavailable"}`,
    `line: ${payload.line ?? "unavailable"}`,
    `column: ${payload.column ?? "unavailable"}`,
    "stack:",
    payload.stack ?? "unavailable",
    "componentStack:",
    payload.componentStack ?? "unavailable",
    "diagnostics:",
    payload.diagnostics ? JSON.stringify(payload.diagnostics) : "unavailable",
    "",
  ].join("\n");
}
