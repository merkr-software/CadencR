import type { AgentSessionProps } from "./types";

/**
 * Session fields the composer never reads. They change on every stream
 * delta, so comparing them would re-render the whole composer per token.
 */
const TRANSCRIPT_KEYS: ReadonlySet<string> = new Set([
  "blocks",
  "rootBlocks",
  "toolResultMap",
  "historyPrependDisplayOffset",
  "lifecycle",
  "turnClock",
]);

function sameKeys(a: object, b: object): boolean {
  return Object.keys(a).length === Object.keys(b).length;
}

function sessionPropsEqual(a: AgentSessionProps, b: AgentSessionProps): boolean {
  if (a === b) return true;
  // The transcript matters to the composer only as "is this the first prompt".
  if ((a.blocks.length === 0) !== (b.blocks.length === 0)) return false;
  if (!sameKeys(a, b)) return false;
  for (const key of Object.keys(b) as (keyof AgentSessionProps)[]) {
    if (TRANSCRIPT_KEYS.has(key)) continue;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/**
 * `React.memo` comparator for the composer. Every prop, callbacks included,
 * is compared by identity — none is skipped, so a changed callback is never
 * left stale — except the session's transcript fields.
 */
export function composerPropsEqual<P extends { sessionProps: AgentSessionProps }>(
  prev: Readonly<P>,
  next: Readonly<P>,
): boolean {
  if (!sameKeys(prev, next)) return false;
  for (const key of Object.keys(next) as (keyof P)[]) {
    if (key === "sessionProps") continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return sessionPropsEqual(prev.sessionProps, next.sessionProps);
}
