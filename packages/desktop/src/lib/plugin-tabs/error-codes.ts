/**
 * The service's custom tab refusals the desktop answers in its own way
 * (`AppError` codes, `packages/service/src/domain/plugin_tabs`). One spelling,
 * so a renamed code fails the type check instead of silently missing.
 */
export const PLUGIN_TAB_ERROR = {
  /** Switching on needs a consent the list did not know about yet. */
  consentRequired: "PLUGIN_TAB_CONSENT_REQUIRED",
  /** The permissions changed while the user was reviewing them. */
  consentStale: "PLUGIN_TAB_CONSENT_STALE",
  /** On Cadencr's revocation list: nothing can be allowed or turned on. */
  blocked: "PLUGIN_TAB_BLOCKED",
  /** A different marketplace update was staged while the user was reviewing it. */
  updateChanged: "MANAGED_TAB_UPDATE_CHANGED",
  /** No staged marketplace update is waiting any more. */
  updateNotFound: "MANAGED_TAB_UPDATE_NOT_FOUND",
  /** Install refused: the version is on the revocation list. */
  managedBlocked: "MANAGED_TAB_BLOCKED",
  /** Install refused: the revocation list could not be checked. */
  policyUnavailable: "MANAGED_TAB_POLICY_UNAVAILABLE",
  /** Install refused: the version's backend ships no binary for this platform. */
  platformUnsupported: "MANAGED_TAB_PLATFORM_UNSUPPORTED",
  /**
   * A presence renewal for a conversation deleted, possibly from another
   * client: the service took back every lease held in it.
   */
  conversationNotFound: "PLUGIN_TAB_CONVERSATION_NOT_FOUND",
  /** A presence renewal for an archived conversation: refused until it is unarchived. */
  conversationArchived: "PLUGIN_TAB_CONVERSATION_ARCHIVED",
} as const;
