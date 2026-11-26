import type { BrowserFailure } from "../../src/shared/browser-types";
import { browserFailureCopy } from "../../src/shared/browser-error-copy";
import { DEFAULT_LANGUAGE } from "../../src/lib/i18n/languages";
import { uiI18n } from "../../src/shared/ui-i18n";
import { isLoopbackHost } from "./loopback-host";
import type { BrowserTabError, BrowserTabErrorKind } from "./browser-types";

const fallbackText = uiI18n.getFixedT(DEFAULT_LANGUAGE, "ui");
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
  const failure = loadFailure(errorCode, code, parsed, loopback, url);

  return {
    kind,
    failure,
    ...browserFailureCopy(failure, fallbackText),
    url,
    code,
    retryable: true,
  };
}

export function formatBrowserCrashError(reason: string, url: string): BrowserTabError {
  const failure: BrowserFailure = { reason: reason === "oom" ? "outOfMemory" : "crash" };
  return {
    kind: "crash",
    failure,
    ...browserFailureCopy(failure, fallbackText),
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

export function blockedSelfRedirect(url: string): BrowserTabError {
  const failure: BrowserFailure = { reason: "selfRedirect" };
  const copy = browserFailureCopy(failure, fallbackText);
  return { ...formatBlockedNavigationError(copy.title, copy.description, url), failure };
}

function loadFailure(
  errorCode: number,
  code: string | undefined,
  parsed: URL | null,
  loopback: boolean,
  url: string,
): BrowserFailure {
  const host = parsed?.host || url;
  switch (errorCode) {
    case -102:
      return { reason: loopback ? "localRefused" : "refused", host };
    case -105:
      return host
        ? { reason: "notFound", host: parsed?.hostname || url }
        : { reason: "addressMissing" };
    case -106:
      return { reason: "offline" };
    case -118:
    case -7:
      return { reason: "timeout", host };
    case -101:
    case -100:
      return { reason: "interrupted", host };
    case -324:
      return { reason: "emptyResponse", host };
    case -310:
      return { reason: "redirectLoop", host };
    case -109:
      return { reason: "unreachable", host };
    case -6:
      return { reason: "fileMissing" };
    case -312:
      return { reason: "unsafePort" };
    default:
      if (isTlsError(errorCode, code))
        return { reason: loopback ? "localCertificate" : "certificate", host };
      return { reason: "other", host };
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
