import { translateUi } from "@/lib/i18n/ui";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import type {
  BrowserBookmark,
  BrowserHistoryEntry,
  BrowserOmniboxQueryResult,
} from "@/shared/browser-types";
import {
  DEFAULT_BROWSER_SEARCH_ENGINE,
  browserSearchUrl,
  type BrowserSearchEngine,
} from "./browser-settings";

export const MAX_OMNIBOX_SUGGESTIONS = 8;

export type OmniboxResolution =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string };

export type BrowserOmniboxSuggestionSource = "tab" | "bookmark" | "history" | "search";

export interface BrowserOmniboxSuggestion {
  id: string;
  source: BrowserOmniboxSuggestionSource;
  title: string;
  url: string;
  tabId?: string;
  historyId?: string;
}

export class OmniboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmniboxInputError";
  }
}

/** Resolve one submitted omnibox value without making a network request. */
export function resolveOmniboxInput(
  rawInput: string,
  searchEngine: BrowserSearchEngine = DEFAULT_BROWSER_SEARCH_ENGINE,
): OmniboxResolution {
  const input = rawInput.trim();
  if (!input)
    throw new OmniboxInputError(
      translateUi(
        "workspace.tools.browserOmnibox.enterAnAddressOrSearchTerms",
        "Enter an address or search terms.",
      ),
    );
  if (isAbsoluteLocalPath(input)) return { kind: "url", url: input };
  if (input.startsWith("//")) return resolveSchemelessHost(input.slice(2), searchEngine);

  const explicitScheme = /^([a-z][a-z\d+.-]*):/i.exec(input)?.[1]?.toLowerCase();
  if (explicitScheme && !looksLikeHostWithPort(input))
    return resolveExplicitUrl(input, explicitScheme);
  if (!/\s/.test(input) && looksLikeHost(input)) return resolveSchemelessHost(input, searchEngine);
  return { kind: "search", query: input, url: browserSearchUrl(searchEngine, input) };
}

export function buildOmniboxSuggestions(
  query: string,
  tabs: BrowserTabMetadata[],
  library: BrowserOmniboxQueryResult,
  searchEngine: BrowserSearchEngine,
): BrowserOmniboxSuggestion[] {
  const needle = query.trim().toLocaleLowerCase();
  const suggestions: BrowserOmniboxSuggestion[] = [];
  const seen = new Set<string>();
  const resolution = safeResolution(query, searchEngine);

  if (resolution?.kind === "search") {
    suggestions.push({
      id: `search:${resolution.url}`,
      source: "search",
      title: resolution.query,
      url: resolution.url,
    });
    seen.add(dedupeUrl(resolution.url));
  }

  for (const tab of rankedTabs(tabs, needle)) {
    pushUnique(suggestions, seen, {
      id: `tab:${tab.id}`,
      source: "tab",
      title: displayTitle(tab.title, tab.url),
      url: tab.url,
      tabId: tab.id,
    });
  }
  for (const bookmark of library.bookmarks) pushBookmark(suggestions, seen, bookmark);
  for (const entry of library.history) pushHistory(suggestions, seen, entry);
  return suggestions.slice(0, MAX_OMNIBOX_SUGGESTIONS);
}

function resolveExplicitUrl(input: string, scheme: string): OmniboxResolution {
  if (scheme === "about") {
    if (input.toLowerCase() === "about:blank") return { kind: "url", url: "about:blank" };
    throw blockedScheme(scheme);
  }
  if (scheme !== "http" && scheme !== "https" && scheme !== "file") throw blockedScheme(scheme);
  try {
    const parsed = new URL(input);
    if (scheme === "http" || scheme === "https") {
      if (!parsed.hostname) throw new Error("missing hostname");
      parsed.username = "";
      parsed.password = "";
    }
    return { kind: "url", url: parsed.toString() };
  } catch {
    throw new OmniboxInputError(
      translateUi(
        "workspace.tools.browserOmnibox.thatAddressIsNotValid",
        "That address is not valid.",
      ),
    );
  }
}

function resolveSchemelessHost(
  input: string,
  searchEngine: BrowserSearchEngine,
): OmniboxResolution {
  const provisional = safeUrl(`https://${input}`);
  if (!provisional?.hostname || !isNavigableHost(provisional.hostname)) {
    return { kind: "search", query: input, url: browserSearchUrl(searchEngine, input) };
  }
  provisional.protocol = isLocalOrPrivateHost(provisional.hostname) ? "http:" : "https:";
  provisional.username = "";
  provisional.password = "";
  return { kind: "url", url: provisional.toString() };
}

function looksLikeHost(input: string): boolean {
  const parsed = safeUrl(`https://${input}`);
  return parsed !== null && isNavigableHost(parsed.hostname);
}

function looksLikeHostWithPort(input: string): boolean {
  return /^(?:localhost|[^\s/:]+\.[^\s/:]+|\d{1,3}(?:\.\d{1,3}){3}):\d+(?:[/#?]|$)/i.test(input);
}

function isNavigableHost(rawHostname: string): boolean {
  const hostname = withoutIpv6Brackets(rawHostname).toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIpv4(hostname) || hostname.includes(":")) return true;
  if (!hostname.includes(".")) return false;
  return hostname
    .split(".")
    .filter(Boolean)
    .every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

export function isLocalOrPrivateHost(rawHostname: string): boolean {
  const hostname = withoutIpv6Brackets(rawHostname).toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.includes(":")) {
    if (hostname === "::1" || hostname === "::") return true;
    const firstHextet = Number.parseInt(hostname.split(":")[0] || "0", 16);
    if ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80) return true;
    const mapped = ipv4MappedParts(hostname);
    return mapped ? isPrivateIpv4Parts(mapped) : false;
  }
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  return isPrivateIpv4Parts(parts);
}

function isPrivateIpv4Parts(parts: number[]): boolean {
  const [first, second] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function ipv4MappedParts(hostname: string): number[] | null {
  const dotted = /^::ffff:(\d+(?:\.\d+){3})$/.exec(hostname)?.[1];
  if (dotted) return ipv4Parts(dotted);
  const hexadecimal = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(hostname);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1] ?? "", 16);
  const low = Number.parseInt(hexadecimal[2] ?? "", 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function rankedTabs(tabs: BrowserTabMetadata[], needle: string): BrowserTabMetadata[] {
  const matchingTabs = tabs.filter((tab) => {
    if (tab.url === "about:blank") return false;
    if (!needle) return true;
    return `${tab.title}\n${tab.url}`.toLocaleLowerCase().includes(needle);
  });
  return matchingTabs.sort((left, right) => Number(right.isActive) - Number(left.isActive));
}

function pushBookmark(
  suggestions: BrowserOmniboxSuggestion[],
  seen: Set<string>,
  bookmark: BrowserBookmark,
): void {
  pushUnique(suggestions, seen, {
    id: `bookmark:${bookmark.id}`,
    source: "bookmark",
    title: displayTitle(bookmark.title, bookmark.url),
    url: bookmark.url,
  });
}

function pushHistory(
  suggestions: BrowserOmniboxSuggestion[],
  seen: Set<string>,
  entry: BrowserHistoryEntry,
): void {
  pushUnique(suggestions, seen, {
    id: `history:${entry.id}`,
    source: "history",
    title: displayTitle(entry.title, entry.url),
    url: entry.url,
    historyId: entry.id,
  });
}

function pushUnique(
  suggestions: BrowserOmniboxSuggestion[],
  seen: Set<string>,
  suggestion: BrowserOmniboxSuggestion,
): void {
  const key = dedupeUrl(suggestion.url);
  if (seen.has(key)) return;
  seen.add(key);
  suggestions.push(suggestion);
}

function safeResolution(input: string, engine: BrowserSearchEngine): OmniboxResolution | null {
  try {
    return resolveOmniboxInput(input, engine);
  } catch {
    return null;
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function dedupeUrl(value: string): string {
  const parsed = safeUrl(value);
  if (!parsed) return value;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function displayTitle(title: string, url: string): string {
  return title || url;
}

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpv4(hostname: string): boolean {
  return ipv4Parts(hostname) !== null;
}

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isAbsoluteLocalPath(input: string): boolean {
  return input.startsWith("/") && !input.startsWith("//");
}

function blockedScheme(scheme: string): OmniboxInputError {
  return new OmniboxInputError(
    translateUi(
      "workspace.tools.browserOmnibox.blockedScheme",
      "Navigation to {{scheme}}: addresses is blocked.",
      { scheme },
    ),
  );
}
