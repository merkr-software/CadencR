import { useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useBrowserDefaultMode } from "@/lib/browser-settings";
import { useInternalDomains } from "@/hooks/useInternalDomains";
import { openLink } from "@/lib/link-routing";
import { LinkRoutingContext, type LinkRouting } from "./LinkRoutingContext";

interface LinkRoutingProviderProps {
  /** Feature scope for Cadencr browser tabs, or null when none applies. */
  scopeId: number | null;
  children: ReactNode;
}

/**
 * Supplies the shared link router to the terminal and agent chat within a
 * feature. Reads the domain policy and default cookie mode once, then exposes
 * stable callbacks (so cached markdown subtrees never re-render):
 *  - `activate` opens a link on Cmd/Ctrl+Click using the domain policy.
 *  - `setHoverLink` keeps the native context menu informed of the link the
 *    pointer is over, scoped to this feature.
 */
export function LinkRoutingProvider({ scopeId, children }: LinkRoutingProviderProps): ReactElement {
  const domains = useInternalDomains();
  const { mode } = useBrowserDefaultMode();

  // Read latest policy via refs so the context callbacks stay referentially
  // stable regardless of setting/mode changes.
  const domainsRef = useRef(domains);
  domainsRef.current = domains;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const scopeRef = useRef(scopeId);
  scopeRef.current = scopeId;
  // Avoid spamming the main process with identical hover updates.
  const lastHoverRef = useRef<string | null>(null);

  const router = useMemo<LinkRouting>(
    () => ({
      activate: (url) => {
        void openLink(url, {
          target: "auto",
          scopeId: scopeRef.current,
          cookieMode: modeRef.current,
          domains: domainsRef.current,
        });
      },
      setHoverLink: (url) => {
        if (lastHoverRef.current === url) return;
        lastHoverRef.current = url;
        void desktopBridge.setLinkHoverContext(
          url === null ? null : { url, scopeId: scopeRef.current, cookieMode: modeRef.current },
        );
      },
    }),
    [],
  );

  return <LinkRoutingContext.Provider value={router}>{children}</LinkRoutingContext.Provider>;
}
