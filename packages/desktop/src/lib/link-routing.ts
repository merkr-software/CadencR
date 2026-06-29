import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { showBrowserError } from "@/components/browser/browser-errors";
import { PROFILE_ID, type CookieMode } from "@/lib/browser-settings";
import { activateFeatureTab } from "@/stores/feature-layout-store";

/**
 * Single source of truth for where a clicked link opens. The terminal and the
 * agent-chat markdown renderer both route through here so behaviour stays
 * identical and is driven purely by the user's domain policy — no
 * surface-specific branches.
 *
 *  - A link whose host matches a configured "internal" domain opens in
 *    Cadencr's own browser tab (scoped to the current feature).
 *  - Anything else opens in the system default browser.
 */

/** Workspace setting holding the JSON list of domains that open in Cadencr's browser. */
export const INTERNAL_DOMAINS_SETTING_KEY = "browser_internal_domains";

/** Seeded list when the user hasn't configured one — local dev servers. */
export const DEFAULT_INTERNAL_DOMAINS: readonly string[] = ["localhost", "127.0.0.1"];

/**
 * `auto` lets the domain policy decide; `cadencr` / `default` are explicit
 * choices made from the right-click menu.
 */
export type LinkTarget = "auto" | "cadencr" | "default";

export interface OpenLinkOptions {
  target: LinkTarget;
  /** The feature scope for a Cadencr browser tab, or null when none is available. */
  scopeId: number | null;
  /** Cookie mode for a freshly-created Cadencr browser tab. */
  cookieMode: CookieMode;
  /** Configured internal domains. */
  domains: readonly string[];
}

/**
 * The link the pointer is over, pushed to the main process so its native
 * right-click menu can offer feature-scoped open choices. Mirrored
 * structurally by the main process; keep the shapes in sync.
 */
export interface LinkHoverContext {
  url: string;
  scopeId: number | null;
  cookieMode: CookieMode;
}

/** Payload relayed back from the native context menu when an item is chosen. */
export interface LinkMenuOpenPayload {
  url: string;
  target: "cadencr" | "default";
  scopeId: number | null;
  cookieMode: CookieMode;
}

/** Parse the stored JSON list; falls back to the defaults when unset or malformed. */
export function parseInternalDomains(value: string | null | undefined): string[] {
  if (value == null || value.length === 0) return [...DEFAULT_INTERNAL_DOMAINS];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Malformed value — treat as unset rather than throwing on every link click.
  }
  return [...DEFAULT_INTERNAL_DOMAINS];
}

/** Serialize a domain list for persistence. */
export function serializeInternalDomains(domains: readonly string[]): string {
  return JSON.stringify(domains);
}

/** True when `url`'s host equals, or is a subdomain of, any configured domain. */
export function matchesInternalDomain(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const candidate = domain.trim().toLowerCase();
    if (candidate.length === 0) return false;
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

/** Resolve an `auto` target to a concrete one using the domain policy. */
export function resolveTarget(
  url: string,
  domains: readonly string[],
  scopeId: number | null,
): "cadencr" | "default" {
  // Without a feature scope (or a desktop shell) there's no Cadencr browser to
  // open into, so the only sensible target is the system browser.
  if (scopeId == null || !isDesktopShell()) return "default";
  return matchesInternalDomain(url, domains) ? "cadencr" : "default";
}

async function openInDefaultBrowser(url: string): Promise<void> {
  try {
    await desktopBridge.openExternalLink(url);
  } catch (error) {
    showBrowserError(error, "Could not open link");
  }
}

async function openInCadencrBrowser(url: string, options: OpenLinkOptions): Promise<void> {
  if (options.scopeId == null || !isDesktopShell()) {
    await openInDefaultBrowser(url);
    return;
  }
  try {
    await desktopBridge.createBrowserTab(url, PROFILE_ID[options.cookieMode], options.scopeId);
    // Reveal the feature's Browser panel so the freshly-opened tab is visible
    // rather than loading behind the terminal or agent chat.
    activateFeatureTab(options.scopeId, "browser");
  } catch (error) {
    showBrowserError(error, "Could not open in Cadencr browser");
  }
}

/** Open `url` according to `options`, surfacing any failure as a toast. */
export async function openLink(url: string, options: OpenLinkOptions): Promise<void> {
  const target =
    options.target === "auto"
      ? resolveTarget(url, options.domains, options.scopeId)
      : options.target;
  if (target === "cadencr") {
    await openInCadencrBrowser(url, options);
    return;
  }
  await openInDefaultBrowser(url);
}
