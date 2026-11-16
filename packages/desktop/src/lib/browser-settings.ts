import { EyeOff, Globe, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";

/** Workspace setting holding the browser tab's default cookie mode. */
export const BROWSER_DEFAULT_MODE_SETTING_KEY = "browser_default_mode";
export const BROWSER_SEARCH_ENGINE_SETTING_KEY = "browser_search_engine";

/** Two cookie modes the user can pick. Normal reuses an on-disk profile; private is in-memory only. */
export type CookieMode = "normal" | "private";

/** Profile id passed to the backend for each mode. "default" → persistent partition, "fresh" → ephemeral. */
export const PROFILE_ID: Record<CookieMode, string> = { normal: "default", private: "fresh" };

export const DEFAULT_COOKIE_MODE: CookieMode = "normal";
export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "google";

export type BrowserSearchEngine = "google" | "duckduckgo" | "bing" | "brave";

export interface BrowserSearchEngineOption {
  value: BrowserSearchEngine;
  label: string;
  queryUrl: string;
}

export const BROWSER_SEARCH_ENGINE_OPTIONS: readonly BrowserSearchEngineOption[] = [
  { value: "google", label: "Google", queryUrl: "https://www.google.com/search?q=" },
  { value: "duckduckgo", label: "DuckDuckGo", queryUrl: "https://duckduckgo.com/?q=" },
  { value: "bing", label: "Bing", queryUrl: "https://www.bing.com/search?q=" },
  { value: "brave", label: "Brave Search", queryUrl: "https://search.brave.com/search?q=" },
] as const;

export function parseCookieMode(value: string | null | undefined): CookieMode {
  return value === "private" ? "private" : DEFAULT_COOKIE_MODE;
}

export function parseBrowserSearchEngine(value: string | null | undefined): BrowserSearchEngine {
  return BROWSER_SEARCH_ENGINE_OPTIONS.some((option) => option.value === value)
    ? (value as BrowserSearchEngine)
    : DEFAULT_BROWSER_SEARCH_ENGINE;
}

export function browserSearchUrl(engine: BrowserSearchEngine, query: string): string {
  const option =
    BROWSER_SEARCH_ENGINE_OPTIONS.find((candidate) => candidate.value === engine) ??
    BROWSER_SEARCH_ENGINE_OPTIONS[0];
  return `${option.queryUrl}${encodeURIComponent(query)}`;
}

export interface BrowserModeOption {
  value: CookieMode;
  label: string;
  description: string;
  icon: LucideIcon;
  /** CSS variable for the icon's accent color. */
  iconColorVar: string;
}

export const BROWSER_MODE_OPTIONS: readonly BrowserModeOption[] = [
  {
    value: "normal",
    label: "Normal",
    description:
      "Reuses a persistent profile. Cookies and logins are kept on disk and shared between sessions.",
    icon: Globe,
    iconColorVar: "var(--acc-blue)",
  },
  {
    value: "private",
    label: "Private",
    description:
      "Ephemeral in-memory session. Cookies and storage are discarded when the tab closes.",
    icon: EyeOff,
    iconColorVar: "var(--muted-foreground)",
  },
] as const;

export interface UseBrowserDefaultModeResult {
  mode: CookieMode;
  isLoading: boolean;
}

export interface UseBrowserSearchEngineResult {
  engine: BrowserSearchEngine;
  isLoading: boolean;
}

/** Read-only view of the user's default browser mode (Settings → Browser). */
export function useBrowserDefaultMode(): UseBrowserDefaultModeResult {
  const setting = useSetting(BROWSER_DEFAULT_MODE_SETTING_KEY);
  return { mode: parseCookieMode(setting.value), isLoading: setting.isLoading };
}

/** Read-only view of the selected address-bar search engine. */
export function useBrowserSearchEngine(): UseBrowserSearchEngineResult {
  const setting = useSetting(BROWSER_SEARCH_ENGINE_SETTING_KEY);
  const engine = parseBrowserSearchEngine(setting.value);
  const isLoading = setting.isLoading;
  return useMemo(() => ({ engine, isLoading }), [engine, isLoading]);
}
