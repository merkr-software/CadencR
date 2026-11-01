import { ingestDiagnostic } from "@/api/generated";
import { rendererRemoteDiagnostic } from "@/shared/telemetry-diagnostics";
import type { RendererErrorReportPayload } from "./desktop-bridge-types";
import { isBrowserRemote } from "./remote/device-token";

let pending = false;
let lastAttempt = 0;
let unavailable = false;

export function browserTelemetryRelayStatus(): Promise<"idle" | "unavailable"> {
  return Promise.resolve(unavailable ? "unavailable" : "idle");
}

/** The local development browser has no trusted bundle manifest. Paired remote devices never relay. */
export function relayBrowserDiagnostic(payload: RendererErrorReportPayload): void {
  if (isBrowserRemote()) return;
  if (pending || Date.now() - lastAttempt < 1000) return;
  pending = true;
  lastAttempt = Date.now();
  void ingestDiagnostic(rendererRemoteDiagnostic(payload, new Set()), AbortSignal.timeout(2000))
    .then(() => {
      unavailable = false;
    })
    .catch(() => {
      unavailable = true;
    })
    .finally(() => {
      pending = false;
    });
}
