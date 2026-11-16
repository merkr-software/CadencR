import { mainRemoteDiagnostic } from "../../src/shared/telemetry-diagnostics";
import { relayRemoteDiagnostic } from "./telemetry-relay";

function reportMainDiagnostic(error: unknown): void {
  relayRemoteDiagnostic(mainRemoteDiagnostic(error));
}

interface ErrorMonitor {
  on(event: "uncaughtExceptionMonitor", listener: (error: Error) => void): unknown;
}
const installed = new WeakSet<ErrorMonitor>();

/** Monitoring preserves Node's normal fatal-error handling. */
export function installMainTelemetry(target: ErrorMonitor = process): void {
  if (installed.has(target)) return;
  installed.add(target);
  target.on("uncaughtExceptionMonitor", reportMainDiagnostic);
}
