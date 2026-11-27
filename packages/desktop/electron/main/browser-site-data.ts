import type { Cookies, Session } from "electron";
import { translateUi as t } from "../../src/shared/ui-i18n";

/**
 * Clear storage/cache for one origin in one concrete Electron Session.
 *
 * Cookies are removed individually instead of passing `cookies` to
 * `Session.clearData({ origins })`: Chromium intentionally expands that filter
 * to the whole registrable domain. Domain cookies applicable to this host are
 * still shared by definition and their removal can sign sibling hosts out.
 */
export async function clearDataForOrigin(targetSession: Session, origin: string): Promise<void> {
  const parsed = new URL(origin);
  await clearCookiesForHost(targetSession.cookies, parsed);
  await targetSession.clearData({
    origins: [origin],
    originMatchingMode: "origin-in-all-contexts",
    dataTypes: [
      "backgroundFetch",
      "cache",
      "fileSystems",
      "indexedDB",
      "localStorage",
      "serviceWorkers",
      "webSQL",
    ],
  });
}

async function clearCookiesForHost(cookies: Cookies, site: URL): Promise<void> {
  const allCookies = await cookies.get({});
  const applicable = allCookies.filter((cookie) =>
    cookieAppliesToHost(cookie.domain, site.hostname),
  );
  const removals = applicable.map((cookie) => {
    const path = cookie.path?.startsWith("/") ? cookie.path : "/";
    return cookies.remove(`${site.protocol}//${site.host}${path}`, cookie.name);
  });
  const results = await Promise.allSettled(removals);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      t("workspace.browser.site.clearCookiesFailed", "Could not clear all cookies for this site."),
    );
  }
}

export function cookieAppliesToHost(rawDomain: string | undefined, hostname: string): boolean {
  if (!rawDomain) return false;
  const domain = rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
