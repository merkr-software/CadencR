/**
 * What the routed area shows, read from the leaf match's pathname alone (a
 * leaf selector: the search changes on every tab focus and must not re-render
 * the stage).
 */

/** The `ws-session` page: every conversation shares this key. */
export const CONVERSATION_CONTENT_KEY = "/ws-session";
/** `#/`: the phone layout's inbox (or, with `?projectId=`, the project's restore). */
export const HOME_CONTENT_KEY = "/";

/**
 * What the routed page is keyed on. Every conversation shares one key: the
 * conversation layer keeps its workspaces mounted across a switch
 * (`WorkspacePool`), so a switch must re-render that page, not remount it.
 */
export function routedContentKey(pathname: string): string {
  return pathname.startsWith("/ws-session/") ? CONVERSATION_CONTENT_KEY : pathname;
}

export interface StageLayout {
  /** The inbox pane beside the conversation (the phone layout, two panes, on the inbox or a conversation). */
  inboxPane: boolean;
  /** The workspace pool stays mounted: on a conversation, and on the phone inbox it returns from. */
  keepConversations: boolean;
  /** A conversation is on screen. */
  conversationShown: boolean;
}

/**
 * The stage for a page. The pool outlives the phone inbox so the way back to
 * a conversation is a flip, not a cold mount; any other page (settings, the
 * desktop home that redirects) unmounts it, as before.
 */
export function stageLayout(contentKey: string, phone: boolean, twoPanes: boolean): StageLayout {
  const conversationShown = contentKey === CONVERSATION_CONTENT_KEY;
  const phoneHome = phone && contentKey === HOME_CONTENT_KEY;
  return {
    inboxPane: phone && twoPanes && (conversationShown || phoneHome),
    keepConversations: conversationShown || phoneHome,
    conversationShown,
  };
}
