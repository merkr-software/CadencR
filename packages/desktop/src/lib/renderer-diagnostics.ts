import { version as reactVersion } from "react";
import { APP_VERSION } from "./app-version";
import type { DiagnosticContext, DiagnosticEvent } from "@/shared/renderer-diagnostics";
import { normalizeRendererError } from "@/shared/renderer-error";

declare const __APP_BUILD_ID__: string;
const buildId = typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : "development";
const started = Date.now();
const sessionId = crypto.randomUUID();
let duplicatesSuppressed = 0;
const beforeCapture = new Set<() => void>();

export function onDiagnosticCapture(flush: () => void): () => void {
  beforeCapture.add(flush);
  return () => {
    beforeCapture.delete(flush);
  };
}

/** Plain bounded memory: no React/Zustand writes, timers, or per-token storage. */
export function createDiagnosticHistory(now: () => number = Date.now) {
  const events: DiagnosticEvent[] = [];
  const streamBuckets = new Map<string, DiagnosticEvent>();
  return {
    record(kind: DiagnosticEvent["kind"], detail: DiagnosticEvent["detail"]) {
      const time = now();
      const streamKey = kind === "stream" ? JSON.stringify(detail) : null;
      const stream = streamKey ? streamBuckets.get(streamKey) : undefined;
      if (stream && time - stream.at < 1000) {
        stream.count += 1;
        return;
      }
      const last = events.at(-1);
      if (
        last?.kind === kind &&
        time - last.at < 1000 &&
        JSON.stringify(last.detail) === JSON.stringify(detail)
      ) {
        last.count += 1;
        return;
      }
      const entry = { at: time, kind, detail: { ...detail }, count: 1 };
      events.push(entry);
      if (streamKey) {
        streamBuckets.set(streamKey, entry);
        if (streamBuckets.size > 32) streamBuckets.delete(streamBuckets.keys().next().value!);
      }
      if (events.length > 100) events.shift();
    },
    snapshot: () =>
      events
        .filter((event) => now() - event.at <= 60_000)
        .map((event) => ({ ...event, detail: { ...event.detail } })),
  };
}

const history = createDiagnosticHistory();
export const recordDiagnosticEvent = history.record;

const routeSegments = new Set([
  "projects",
  "features",
  "agents",
  "ws-session",
  "settings",
  "marketplace",
  "themes",
  "schedules",
  "browser",
  "terminals",
  "new",
  "archive",
  "archived",
  "about",
]);
export function diagnosticRoute(hash: string): string {
  return hash
    .replace(/^#/, "")
    .split(/[?#]/)[0]
    .split("/")
    .slice(0, 12)
    .map((part) => (!part || routeSegments.has(part) ? part : ":id"))
    .join("/");
}

export function recordDiagnosticSuppression(): void {
  duplicatesSuppressed += 1;
}

export function captureDiagnosticContext(): DiagnosticContext {
  for (const flush of beforeCapture) flush();
  return {
    schemaVersion: 1,
    reportId: crypto.randomUUID(),
    sessionId,
    capturedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    buildId,
    reactVersion,
    userAgent: navigator.userAgent.slice(0, 400),
    route: diagnosticRoute(window.location.hash),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio || 1,
    },
    uptimeMs: Math.max(0, Date.now() - started),
    duplicatesSuppressed,
    breadcrumbs: history.snapshot(),
  };
}

export function formatDiagnosticError(
  error: unknown,
  componentStack: string | null,
  context?: DiagnosticContext | null,
): string {
  return JSON.stringify(
    {
      ...(context ?? captureDiagnosticContext()),
      ...normalizeRendererError(error),
      componentStack,
    },
    null,
    2,
  );
}

export function installDiagnosticBrowserEvents(): () => void {
  const route = () =>
    recordDiagnosticEvent("navigation", { route: diagnosticRoute(location.hash) });
  let resizedAt = 0;
  const resize = () => {
    if (Date.now() - resizedAt < 500) return;
    resizedAt = Date.now();
    recordDiagnosticEvent("viewport", { width: innerWidth, height: innerHeight });
  };
  const visibility = () => recordDiagnosticEvent("visibility", { state: document.visibilityState });
  const click = (event: MouseEvent) => {
    const target =
      event.target instanceof Element ? event.target.closest("button,a,[role=tab]") : null;
    if (target)
      recordDiagnosticEvent("interaction", {
        element: target.tagName.toLowerCase(),
        tab: target.getAttribute("role") === "tab",
      });
  };
  window.addEventListener("hashchange", route);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("click", click, true);
  recordDiagnosticEvent("lifecycle", { event: "renderer-start" });
  route();
  return () => {
    window.removeEventListener("hashchange", route);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("click", click, true);
  };
}
