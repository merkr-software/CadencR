/**
 * Per-animation-frame coalescing of agent stream deltas.
 *
 * Every `session.message` envelope arrives in its own microtask, so React 18
 * auto-batching never merges them: a fast token stream would force one
 * store-notify → render commit per envelope (dozens per second). This buffers
 * the `session.message` payloads and applies the whole burst in a single
 * `handleMessageBatch` (one `set()`) per frame.
 *
 * Ordering guarantee: only `session.message` deltas are buffered. Every other
 * envelope (permissions, lifecycle, errors, initialized) must flush the pending
 * buffer first (see `flushStreamDeltas` calls in the store's `onMessage`) so a
 * non-delta envelope never overtakes the deltas that preceded it.
 */

import type { StoreAccessors } from "./ws-envelope-types";
import { handleMessageBatch } from "./ws-message-envelope-handler";
import { scheduleDeltaFlush } from "./ws-delta-scheduler";

interface SessionBuffer {
  payloads: unknown[];
  scheduled: boolean;
}

const buffersByTransport = new WeakMap<StoreAccessors["transport"], Map<string, SessionBuffer>>();

function getBuffers(ctx: StoreAccessors): Map<string, SessionBuffer> {
  let buffers = buffersByTransport.get(ctx.transport);
  if (!buffers) {
    buffers = new Map();
    buffersByTransport.set(ctx.transport, buffers);
  }
  return buffers;
}

/**
 * Buffer a `session.message` stream-delta payload, scheduling one coalesced
 * flush per frame. A burst of N deltas produces a single store commit.
 */
export function bufferStreamDelta(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const buffers = getBuffers(ctx);
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = { payloads: [], scheduled: false };
    buffers.set(sessionId, buf);
  }
  buf.payloads.push(payload);
  if (buf.scheduled) return;
  buf.scheduled = true;
  scheduleDeltaFlush(() => flushStreamDeltas(ctx, sessionId));
}

/**
 * Apply every buffered delta for a session in one commit. Safe to call anytime:
 * a no-op when the buffer is empty. Called both by the scheduled flush and
 * eagerly before any non-delta envelope so ordering is preserved.
 */
export function flushStreamDeltas(ctx: StoreAccessors, sessionId: string): void {
  const buf = buffersByTransport.get(ctx.transport)?.get(sessionId);
  if (!buf) return;
  buf.scheduled = false;
  if (buf.payloads.length === 0) return;
  const payloads = buf.payloads;
  buf.payloads = [];
  handleMessageBatch(ctx, sessionId, payloads);
}

/**
 * Drop any buffered deltas for a session without applying them. Called on
 * teardown (disconnect/destroy/deleted) so a stale scheduled flush can't apply
 * into a removed session. The deltas are already persisted server-side.
 */
export function discardStreamDeltas(ctx: StoreAccessors, sessionId: string): void {
  buffersByTransport.get(ctx.transport)?.delete(sessionId);
}
