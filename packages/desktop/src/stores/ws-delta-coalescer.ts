/**
 * Per-animation-frame coalescing of agent stream deltas, bounded when no
 * frame comes (see `MAX_PENDING_STREAM_DELTAS`).
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

/**
 * Most deltas one session may hold between flushes. A flush normally comes
 * within a frame (or `DELTA_FLUSH_FALLBACK_MS` with no frames), but a hidden
 * window's timers are throttled: past this many, the buffer is applied at once
 * so memory stays bounded whatever the scheduler does. Far above a frame's
 * worth, so a painting page never hits it.
 */
export const MAX_PENDING_STREAM_DELTAS = 512;

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
  if (buf.payloads.length >= MAX_PENDING_STREAM_DELTAS) {
    // The scheduled flush stays armed; it finds an empty buffer and no-ops.
    applyBufferedDeltas(ctx, sessionId, buf);
    return;
  }
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
  applyBufferedDeltas(ctx, sessionId, buf);
}

function applyBufferedDeltas(ctx: StoreAccessors, sessionId: string, buf: SessionBuffer): void {
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
