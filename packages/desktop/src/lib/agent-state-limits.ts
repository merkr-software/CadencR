/**
 * Number of messages to fetch per session for initial hydration.
 *
 * Kept deliberately small: the agent stream only paints the last handful of
 * blocks on open, so a viewport-sized window lets latest-message + status
 * render near-instantly instead of blocking on a multi-MB payload (tool
 * payloads and diffs are stored inline). Older history streams in lazily as
 * the user scrolls up (see `loadOlderSessionMessages`). `useAgentSessionScroll`
 * backfills automatically if this window underfills the viewport.
 */
export const AGENT_STATE_INITIAL_MESSAGE_LIMIT = 40;

/** Number of messages to fetch per session when loading older history. */
export const AGENT_STATE_OLDER_MESSAGE_LIMIT = 100;
