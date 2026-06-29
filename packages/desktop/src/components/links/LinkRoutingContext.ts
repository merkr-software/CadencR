import { createContext, useContext } from "react";

/**
 * Imperative link actions shared by the terminal and agent-chat markdown.
 * The value is stable for the provider's lifetime so consumers (including
 * markdown links inside cached subtrees) never re-render when it changes.
 *
 * Cmd/Ctrl+Click activation lives here; the right-click menu is rendered by
 * the native (main-process) context menu, fed by `setHoverLink`.
 */
export interface LinkRouting {
  /** Open `url` using the domain policy (internal vs. default browser). */
  activate: (url: string) => void;
  /**
   * Tell the main process which link (if any) the pointer is over, so its
   * native context menu can offer the Cadencr-vs-default open choices scoped
   * to this feature. Pass `null` on leave.
   */
  setHoverLink: (url: string | null) => void;
}

export const LinkRoutingContext = createContext<LinkRouting | null>(null);

/** Returns the link router, or `null` when rendered outside a feature. */
export function useLinkRouting(): LinkRouting | null {
  return useContext(LinkRoutingContext);
}
