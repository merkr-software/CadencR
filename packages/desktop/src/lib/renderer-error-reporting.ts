import { desktopBridge, type RendererErrorReportPayload } from "./desktop-bridge";

import { relayBrowserDiagnostic } from "./telemetry-relay";
import { toast } from "sonner";
import { createDiagnosticGate, type DiagnosticContext } from "@/shared/renderer-diagnostics";
import { captureDiagnosticContext, recordDiagnosticSuppression } from "./renderer-diagnostics";
import { normalizeRendererError } from "@/shared/renderer-error";

type ReportRendererError = (payload: RendererErrorReportPayload) => Promise<void>;

type ReactErrorSource = "react-boundary" | "react-uncaught" | "react-recoverable";

export function installGlobalRendererErrorHandlers(
  report: ReportRendererError = defaultReportRendererError,
): () => void {
  const gate = createDiagnosticGate();
  const reportGlobalError = (payload: RendererErrorReportPayload): void => {
    const accepted = gate.accept(payload);
    if (!accepted) recordDiagnosticSuppression();
    if (accepted) reportSafely(report, { ...payload, diagnostics: captureDiagnosticContext() });
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
    const error = normalizeRendererError(event.error);
    return {
      source: "error",
      message: event.message || error.message,
      stack: error.stack,
      url: event.filename || window.location.href,
      line: event.lineno || null,
      column: event.colno || null,
    };
  }

  const error = normalizeRendererError(event.reason);
  return {
    source: "unhandledrejection",
    message: error.message,
    stack: error.stack,
    url: window.location.href,
    line: null,
    column: null,
  };
}

export const reportReactBoundaryError = createReactErrorReporter();

export function createReactErrorReporter(report: ReportRendererError = defaultReportRendererError) {
  const gate = createDiagnosticGate();
  const pending = new WeakMap<
    object,
    RendererErrorReportPayload & { diagnostics: DiagnosticContext }
  >();
  return (
    error: unknown,
    componentStack: string | null,
    source: ReactErrorSource = "react-boundary",
  ): DiagnosticContext => {
    const boundaryError =
      source === "react-boundary" && typeof error === "object" && error !== null ? error : null;
    const previous = boundaryError ? pending.get(boundaryError) : undefined;
    if (previous) {
      // Consolidate the root hook and componentDidCatch before persisting. Keep
      // the fuller stack before applying repeat suppression.
      if ((componentStack?.trim().length ?? 0) > (previous.componentStack?.trim().length ?? 0))
        previous.componentStack = componentStack;
      return previous.diagnostics;
    }
    const normalized = normalizeRendererError(error);
    const payload: RendererErrorReportPayload & { diagnostics: DiagnosticContext } = {
      source,
      message: normalized.message,
      stack: normalized.stack,
      componentStack,
      url: window.location.href,
      line: null,
      column: null,
      diagnostics: captureDiagnosticContext(),
    };
    if (!gate.accept(payload)) {
      recordDiagnosticSuppression();
      return gate.previousContext(payload)!;
    }
    const submit = (): void => reportSafely(report, payload);
    if (!boundaryError) {
      submit();
      return payload.diagnostics;
    }
    pending.set(boundaryError, payload);
    queueMicrotask(() => {
      pending.delete(boundaryError);
      submit();
    });
    return payload.diagnostics;
  };
}

async function defaultReportRendererError(payload: RendererErrorReportPayload): Promise<void> {
  await desktopBridge.reportRendererError(payload);
  if (!desktopBridge.isElectron) relayBrowserDiagnostic(payload);
}

function reportSafely(report: ReportRendererError, payload: RendererErrorReportPayload): void {
  void report(payload).catch((error: unknown) => {
    console.error("Failed to persist renderer error:", error);
    toast.error("Could not save diagnostic report", {
      id: "renderer-diagnostics-persistence",
      description: `Copy the error details before reloading.${error instanceof Error ? ` ${error.message}` : ""}`,
    });
  });
}
