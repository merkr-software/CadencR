import { useEffect } from "react";
import { desktopBridge } from "@/lib/desktop-bridge";
import { openLink, type LinkMenuOpenPayload } from "@/lib/link-routing";
import { parseCookieMode } from "@/lib/browser-settings";

function parsePayload(raw: LinkMenuOpenPayload): LinkMenuOpenPayload | null {
  if (!raw || typeof raw.url !== "string" || raw.url.length === 0) return null;
  const target = raw.target === "cadencr" ? "cadencr" : "default";
  const scopeId = typeof raw.scopeId === "number" ? raw.scopeId : null;
  return { url: raw.url, target, scopeId, cookieMode: parseCookieMode(raw.cookieMode) };
}

/**
 * App-level listener for the native link context menu. When the user picks
 * "Open in Cadencr/Default browser", main relays the choice here and we open
 * it through the shared router (which reveals the feature's Browser panel for a
 * Cadencr tab).
 */
export function useLinkMenuListener(): void {
  useEffect(() => {
    return desktopBridge.onOpenLinkFromMenu((raw) => {
      const payload = parsePayload(raw);
      if (!payload) return;
      void openLink(payload.url, {
        target: payload.target,
        scopeId: payload.scopeId,
        cookieMode: payload.cookieMode,
        domains: [],
      });
    });
  }, []);
}
