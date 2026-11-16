import { useCallback } from "react";
import type { Feature } from "@/api/generated";
import { portUrl } from "@/lib/feature-ports";
import { openLink } from "@/lib/link-routing";

/**
 * Opens a conversation's dev-server port in that conversation's browser pane.
 * Browser tabs are scoped per feature, so a port opened from another
 * conversation's row would land in a pane the user isn't looking at; the
 * conversation is opened first. `openLink` falls back to the system browser
 * off the desktop shell.
 */
export function useOpenFeaturePort(
  feature: Feature,
  onNavigate: (feature: Feature) => void,
): (port: number) => void {
  return useCallback(
    (port: number): void => {
      onNavigate(feature);
      void openLink(portUrl(port), {
        target: "cadencr",
        scopeId: feature.id,
        cookieMode: "normal",
        domains: [],
      });
    },
    [feature, onNavigate],
  );
}
