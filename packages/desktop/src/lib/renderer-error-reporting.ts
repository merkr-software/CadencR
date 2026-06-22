import { desktopBridge, type RendererErrorReportPayload } from "./desktop-bridge";

type ReportRendererError = (payload: RendererErrorReportPayload) => Promise<void>;

const MAX_GLOBAL_ERROR_REPORTS = 20;

export function installGlobalRendererErrorHandlers(
  report: ReportRendererError = defaultReportRendererError,
): () => void {
  let reports = 0;
  const reportGlobalError = (payload: RendererErrorReportPayload): void => {
    if (reports >= MAX_GLOBAL_ERROR_REPORTS) return;
    reports += 1;
    reportSafely(report, payload);
  };
  const onError = (event: ErrorEvent): void => {
    reportGlobalError(toRendererErrorPayload(event));
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportGlobalError(toRendererErrorPayload(event));
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}

export function toRendererErrorPayload(
  event: ErrorEvent | PromiseRejectionEvent,
): RendererErrorReportPayload {
  if (event instanceof ErrorEvent) {
    const error = errorFromUnknown(event.error);
    return {
      source: "error",
      message: event.message || error.message,
      stack: error.stack,
      url: event.filename || window.location.href,
      line: event.lineno || null,
      column: event.colno || null,
    };
  }

  const error = errorFromUnknown(event.reason);
  return {
    source: "unhandledrejection",
    message: error.message,
    stack: error.stack,
    url: window.location.href,
    line: null,
    column: null,
  };
}

export function reportReactBoundaryError(error: Error, componentStack: string | null): void {
  reportSafely(defaultReportRendererError, {
    source: "react-boundary",
    message: error.message || String(error),
    stack: error.stack ?? null,
    componentStack,
    url: window.location.href,
    line: null,
    column: null,
  });
}

function defaultReportRendererError(payload: RendererErrorReportPayload): Promise<void> {
  return desktopBridge.reportRendererError(payload);
}

function errorFromUnknown(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) {
    return { message: value.message || String(value), stack: value.stack ?? null };
  }
  return { message: stringifyUnknown(value), stack: null };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function reportSafely(report: ReportRendererError, payload: RendererErrorReportPayload): void {
  void report(payload).catch((error: unknown) => {
    console.error("Failed to persist renderer error:", error);
  });
}
