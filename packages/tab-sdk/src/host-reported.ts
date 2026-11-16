import { CadencrError } from "./errors.js";

/**
 * The `backend.request` failure codes Cadencr reports to the user itself — a
 * toast naming the tab, with a link to its Activity — because they keep the
 * backend from running at all and no retry by the page fixes them. A page
 * should not repeat them. Every other rejection (`TIMEOUT`, a busy or exited
 * backend, the backend's own method errors…) is the page's to show.
 */
export const HOST_REPORTED_BACKEND_CODES = [
  "PLUGIN_BACKEND_NOT_NATIVE",
  "PLUGIN_BACKEND_UNSIGNED",
  "PLUGIN_BACKEND_UNAVAILABLE",
  "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM",
  "PLUGIN_BACKEND_TAMPERED",
  "MANAGED_TAB_POLICY_UNAVAILABLE",
  "PLUGIN_TAB_BLOCKED",
  "PLUGIN_BACKEND_NOT_READY",
  "PLUGIN_BACKEND_PROTOCOL_MISMATCH",
  "PLUGIN_BACKEND_CRASHING",
  "PLUGIN_BACKEND_START_FAILING",
] as const;

export type HostReportedBackendCode = (typeof HOST_REPORTED_BACKEND_CODES)[number];

const REPORTED: ReadonlySet<string> = new Set(HOST_REPORTED_BACKEND_CODES);

/**
 * Whether Cadencr already told the user about this `backend.request`
 * rejection, so the page can skip its own message:
 *
 * ```ts
 * catch (error) {
 *   if (!isReportedByHost(error)) showError(toCadencrError(error).message);
 * }
 * ```
 */
export function isReportedByHost(error: unknown): boolean {
  return error instanceof CadencrError && REPORTED.has(error.code);
}
