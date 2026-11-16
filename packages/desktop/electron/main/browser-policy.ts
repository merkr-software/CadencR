import { pathToFileURL } from "node:url";
import { isLoopbackHost } from "./loopback-host";
import { isCadencrBrowserUrl } from "./browser-self-origin-policy";
import { isBrowserOriginPolicyReady } from "./runtime-config";

export type BrowserAutomationAccess = "full" | "read-only" | "denied";

const SENSITIVE_HEADER_PATTERNS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "access_token",
  "refresh_token",
  "token",
] as const;

export function isLocalhostAutomationUrl(rawUrl: string): boolean {
  const parsed = safeUrl(rawUrl);
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return isLoopbackHost(parsed.hostname);
}

export function browserAutomationAccess(rawUrl: string): BrowserAutomationAccess {
  const parsed = safeUrl(rawUrl);
  if (!parsed) return "denied";
  if (isCadencrBrowserUrl(rawUrl)) return "denied";
  if (isLocalhostAutomationUrl(rawUrl)) return "full";
  if (parsed.protocol === "https:") return "read-only";
  return "denied";
}

export function assertBrowserAgentUrl(rawUrl: string, external = false): string {
  if (!isBrowserOriginPolicyReady()) {
    throw new Error("Browser access is unavailable until Cadencr's listener origins are verified.");
  }
  const url = normalizeBrowserOpenUrl(rawUrl);
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    isCadencrBrowserUrl(url) ||
    (!external && !isLocalhostAutomationUrl(url))
  ) {
    throw new Error("Browser MCP requires a web development URL outside Cadencr's own origins.");
  }
  return url;
}

export function normalizeBrowserOpenUrl(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) throw new Error("Browser URL is required.");
  const candidate = trimmed.startsWith("/")
    ? pathToFileURL(trimmed).href
    : needsHttpPrefix(trimmed)
      ? `http://${trimmed}`
      : trimmed;
  const parsed = safeUrl(candidate);
  if (!parsed) throw new Error("Browser URL is invalid.");
  if (parsed.href === "about:blank") return parsed.href;
  if (parsed.protocol === "javascript:") {
    throw new Error(`Browser navigation blocked for ${parsed.protocol} URLs.`);
  }
  // Local files load directly; Chromium still blocks web origins from
  // navigating to file: URLs on its own, so only user-initiated opens reach here.
  if (parsed.protocol === "file:") return parsed.toString();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser navigation blocked for ${parsed.protocol} URLs.`);
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function redactBrowserHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const redacted: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = isSensitiveHeader(name) ? "[redacted]" : value;
  }
  return redacted;
}

function needsHttpPrefix(input: string): boolean {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(input)) return true;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input)) return false;
  return true;
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern));
}

function safeUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}
