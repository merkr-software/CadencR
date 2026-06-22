import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { optionalNumber, requiredRecord, requiredString } from "./browser-arg-validation";

type RendererErrorSource = "error" | "unhandledrejection" | "react-boundary";

interface RendererErrorPayload {
  source: RendererErrorSource;
  message: string;
  stack?: string | null;
  componentStack?: string | null;
  url?: string | null;
  line?: number | null;
  column?: number | null;
}

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
  const payload = parseRendererErrorPayload(rawPayload);
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  appendFileSync(options.logPath, buildRendererErrorLog(payload, options), "utf8");
}

function parseRendererErrorPayload(rawPayload: unknown): RendererErrorPayload {
  const payload = requiredRecord(rawPayload, "renderer error payload");
  const source = parseSource(payload.source);
  return {
    source,
    message: clamp(requiredString(payload.message, "renderer error message"), 4000),
    stack: optionalString(payload.stack, 12000),
    componentStack: optionalString(payload.componentStack, 12000),
    url: optionalString(payload.url, 4000),
    line: optionalFiniteNumber(payload.line),
    column: optionalFiniteNumber(payload.column),
  };
}

function parseSource(rawSource: unknown): RendererErrorSource {
  if (rawSource === "error" || rawSource === "unhandledrejection" || rawSource === "react-boundary")
    return rawSource;
  throw new Error("Expected renderer error source.");
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Expected renderer error field to be a string.");
  return clamp(value, maxLength);
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = optionalNumber(value);
  if (parsed === undefined) throw new Error("Expected renderer error position to be numeric.");
  return parsed;
}

function clamp(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function buildRendererErrorLog(
  payload: RendererErrorPayload,
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
    "",
  ].join("\n");
}
