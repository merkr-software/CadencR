import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Max re-parse cadence for the actively streaming markdown block. */
const STREAMING_REPARSE_MS = 100;

/**
 * Rate-limit how often the actively streaming markdown block re-parses.
 *
 * The streaming block's content grows on every coalesced delta batch, and the
 * markdown block still being written is re-parsed in full each time — O(length²)
 * across a long stream. (Streamdown memoizes the *settled* blocks above it, so
 * this is bounded by the current block rather than the whole message, but the
 * quadratic is still there.) While `active`, this returns text that advances at
 * most every ~100ms, so the parse cost is bounded by a time cadence rather than
 * the token rate. When not streaming (or once it stops) the latest content
 * passes through immediately so the final message is never left truncated.
 *
 * Publishing is timer-only and flushed synchronously inside that timer task,
 * never from the effect: a setState scheduled from the effect of a sync
 * (WebSocket-driven) commit leaves a default-lane update pending at the tail
 * of that commit, and React's module-global nested-update counter throws error
 * #185 once ~50 consecutive sync commits end that way (see issue #211 and
 * 2bf1b003 for the previous instance). The flushed render commits before the
 * task ends, so this publish is never left pending for a later commit to
 * count. Being a sync commit, it also runs the markdown subtree's passive
 * effects in place: one of them setting state leaves a single default-lane
 * update behind, which the next clean commit resets — never one per frame.
 * It is not a transition either: every WebSocket flush commits on the
 * sync lane and restarts an interruptible render, so once the parse outlasts
 * a frame (slow CPU, long block) the transition never committed and the text
 * froze for seconds.
 */
export function useStreamingMarkdownThrottle(content: string, active: boolean): string {
  const [throttled, setThrottled] = useState(content);
  const [prevActive, setPrevActive] = useState(active);
  const latestRef = useRef(content);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  latestRef.current = content;

  // Seed the throttled value when a stream (re)starts, so reactivation after
  // the content changed while inactive never flashes stale text. A
  // render-phase update re-renders before commit and leaves nothing pending,
  // unlike publishing from the effect.
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) setThrottled(content);
  }

  useEffect(() => {
    if (!active) {
      // Not (or no longer) streaming: the hook returns `content` directly, so
      // there is nothing to publish — just disarm the trailing timer.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    // Within the window: let the already-scheduled trailing update pick up the
    // latest content instead of scheduling a second timer.
    if (timerRef.current) return;
    const wait = Math.max(0, STREAMING_REPARSE_MS - (Date.now() - lastEmitRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushSync(() => {
        setThrottled((prev) => (prev === latestRef.current ? prev : latestRef.current));
      });
      // Stamped after the render: a parse that outlasts the window still
      // leaves a full window idle before the next one, so a slow machine
      // never chains uninterruptible parses back to back.
      lastEmitRef.current = Date.now();
    }, wait);
  }, [content, active]);

  // Cancel the pending publish on teardown and forget it. The fiber can
  // outlive its effects (StrictMode replays them on mount; a disconnected
  // subtree reconnects): the replayed effect must then arm a fresh timer, not
  // trust the cancelled one, or the block stays frozen until the turn ends.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );

  return active ? throttled : content;
}
