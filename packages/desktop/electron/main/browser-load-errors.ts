import { isLoopbackHost } from "./loopback-host";
import type { BrowserTabError, BrowserTabErrorKind } from "./browser-types";

const ERR_ABORTED_CODE = -3;
const ERR_ABORTED_PATTERN = /\bERR_ABORTED\b/;
const CHROMIUM_LOAD_ERROR_PATTERN = /\bERR_[A-Z0-9_]+\s*\(-\d+\)\s+loading\b/;

export function isIgnoredLoadErrorCode(errorCode: number): boolean {
  return errorCode === ERR_ABORTED_CODE;
}

export function isViewportPageError(error: BrowserTabError | null | undefined): boolean {
  return error?.kind === "load" || error?.kind === "security" || error?.kind === "crash";
}

/**
 * Electron rejects `webContents.loadURL` for aborted loads and for every
 * Chromium network failure that also fires `did-fail-load`. Ignore those here
 * so `did-fail-load` remains the single source of truth for page load errors.
 */
export function isIgnoredLoadUrlRejection(error: unknown): boolean {
  let message = "";
  if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object") {
    const record = error as { errno?: unknown; code?: unknown; message?: unknown };
    if (record.errno === ERR_ABORTED_CODE || record.code === "ERR_ABORTED") return true;
    if (typeof record.message === "string") message = record.message;
  }
  return ERR_ABORTED_PATTERN.test(message) || CHROMIUM_LOAD_ERROR_PATTERN.test(message);
}

export function formatBrowserLoadError(
  errorCode: number,
  description: string,
  url: string,
): BrowserTabError {
  const code = description.trim() || undefined;
  const parsed = safeUrl(url);
  const loopback = parsed !== null && isLoopbackHost(parsed.hostname);
  const kind: BrowserTabErrorKind =
    errorCode === -312 || isTlsError(errorCode, code) ? "security" : "load";
  const { title, description: message } = describeLoadError(errorCode, code, parsed, loopback, url);

  return {
    kind,
    title,
    description: message,
    url,
    code,
    retryable: true,
  };
}

export function formatBrowserCrashError(reason: string, url: string): BrowserTabError {
  const oom = reason === "oom";
  return {
    kind: "crash",
    title: oom ? "This page ran out of memory" : "This page crashed",
    description: oom
      ? "Reload the tab to try again."
      : "Something went wrong while displaying this page. Reload to try again.",
    url,
    code: reason,
    retryable: true,
  };
}

export function formatBlockedNavigationError(
  title: string,
  description: string,
  url?: string,
): BrowserTabError {
  return {
    kind: "blocked",
    title,
    description,
    ...(url !== undefined ? { url } : {}),
    retryable: false,
  };
}

function describeLoadError(
  errorCode: number,
  code: string | undefined,
  parsed: URL | null,
  loopback: boolean,
  url: string,
): { title: string; description: string } {
  const host = parsed?.host || url || "this site";
  switch (errorCode) {
    case -102:
      if (loopback && parsed) {
        return {
          title: `Can't connect to ${parsed.host}`,
          description: "Nothing is listening on this port. Make sure your dev server is running.",
        };
      }
      return { title: "This site can't be reached", description: `${host} refused to connect.` };
    case -105: {
      const target = parsed?.hostname || url;
      return {
        title: "Site not found",
        description: target
          ? `Check the address for typos (${target}).`
          : "Check the address for typos.",
      };
    }
    case -106:
      return {
        title: "No internet connection",
        description: "Check your network connection and try again.",
      };
    case -118:
    case -7:
      return { title: "Connection timed out", description: `${host} took too long to respond.` };
    case -101:
    case -100:
      return {
        title: "Connection interrupted",
        description: `The connection to ${host} was closed unexpectedly.`,
      };
    case -324:
      return { title: "No response from server", description: `${host} didn't send any data.` };
    case -310:
      return {
        title: "Too many redirects",
        description: `${host} redirected you too many times.`,
      };
    case -109:
      return { title: "Address unreachable", description: `Could not reach ${host}.` };
    case -6:
      return { title: "File not found", description: "The requested file could not be found." };
    case -312:
      return { title: "Port blocked", description: "This port is blocked for security reasons." };
    default:
      if (isTlsError(errorCode, code)) {
        return {
          title: "Connection isn't private",
          description: loopback
            ? `The local HTTPS certificate for ${host} isn't trusted.`
            : `The security certificate for ${host} isn't trusted.`,
        };
      }
      return {
        title: "This page can't be loaded",
        description: `Could not load ${parsed?.host || url || "this page"}.`,
      };
  }
}

function isTlsError(errorCode: number, code: string | undefined): boolean {
  if (errorCode <= -200 && errorCode >= -217) return true;
  if (!code) return false;
  return code.startsWith("ERR_CERT_") || code.startsWith("ERR_SSL_");
}

function safeUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}
