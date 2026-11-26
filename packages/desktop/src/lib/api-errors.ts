import { isAxiosError } from "axios";
import { toast } from "sonner";

interface ApiErrorBody {
  error?: unknown;
  code?: unknown;
}

/** Electron prefixes errors thrown by an `ipcMain.handle` handler; keep only the handler's message. */
const ELECTRON_IPC_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;
const LEADING_ERROR_PREFIX = /^Error:\s*/;

export function stripElectronIpcPrefix(message: string): string {
  return message.replace(ELECTRON_IPC_PREFIX, "").replace(LEADING_ERROR_PREFIX, "").trim();
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  const backendMessage = backendErrorMessage(err);
  if (backendMessage) return backendMessage;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return fallback;
}

/** Surface an error to the user as a toast, using the shared message extraction. */
export function toastError(err: unknown, fallback: string): void {
  toast.error(apiErrorMessage(err, fallback));
}

function backendErrorMessage(err: unknown): string | null {
  if (!isAxiosError(err)) return null;
  const data = err.response?.data;
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!isApiErrorBody(data)) return null;
  const error = data.error;
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

/** A settings file the service could not read; the message names it and the cause. */
export const SETTINGS_READ_FAILED = "SETTINGS_READ_FAILED";
export const WORKTREE_UNAVAILABLE = "WORKTREE_UNAVAILABLE";

/** An invalid settings document or stored value that needs to be repaired. */
export function isSettingsRepairError(code: string | null): boolean {
  return code === SETTINGS_READ_FAILED || code === "SETTINGS_INVALID";
}

/** Codes of a `413`: a diff or file refused for its size, which asking again only recomputes. */
const REFUSED_FOR_SIZE: ReadonlySet<string> = new Set(["DIFF_TOO_LARGE", "FILE_TOO_LARGE"]);

/**
 * A query `retry` predicate: the app-wide single retry (`lib/queryClient.ts`),
 * except for a response refused for its size, which a retry only recomputes
 * (up to a 10 MiB diff or a 16 MiB file) to be refused again.
 */
export function retryUnlessRefusedForSize(failureCount: number, error: unknown): boolean {
  const code = apiErrorCode(error);
  return failureCount < 1 && (code === null || !REFUSED_FOR_SIZE.has(code));
}

/** The stable `code` of a service error body (`{error, code}`), if there is one. */
export function apiErrorCode(err: unknown): string | null {
  if (!isAxiosError(err)) return null;
  const data: unknown = err.response?.data;
  if (!isApiErrorBody(data)) return null;
  return typeof data.code === "string" ? data.code : null;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null;
}
