/**
 * Socket `onMessage` dispatch for a session connection — the streaming hot path.
 *
 * Extracted from `ws-session-store.ts` so the coalesce/flush/dispatch wiring
 * lives in one focused module instead of accumulating inside the store factory.
 * The store's `onMessage` callback is a one-line delegation to
 * `handleSocketMessage`.
 */

import { type WsEnvelope, parseEnvelope } from "@/lib/ws-envelope";
import { apiErrorMessage } from "@/lib/api-errors";
import { handleEnvelope } from "./ws-envelope-handler";
import type { StoreAccessors } from "./ws-envelope-handler";
import { appendErrorBlockPatch, makeErrorBlock } from "./ws-session-store-helpers";
import { updateSession } from "./ws-session-types";
import { blocksPatchWithDerived } from "./ws-message-processing";
import { bufferStreamDelta, flushStreamDeltas } from "./ws-delta-coalescer";
import { SESSION_ACTION } from "./ws-session-action-names";
import { parseErrorPayload } from "./ws-envelope-payload";

/** Only `session.message` deltas are coalesced; everything else applies eagerly. */
function isStreamDeltaEnvelope(envelope: WsEnvelope): boolean {
  return envelope.domain === "session" && envelope.action === SESSION_ACTION.message;
}

/** Cheap envelope checks first: this runs for every non-delta frame. */
function isInitRefusal(ctx: StoreAccessors, sessionId: string, envelope: WsEnvelope): boolean {
  if (envelope.domain !== "session" || envelope.action !== SESSION_ACTION.error) return false;
  return envelope.ref != null && envelope.ref === ctx.get().sessions[sessionId]?.initRequestId;
}

function initRefusalMessage(payload: unknown): string {
  const message = parseErrorPayload(payload)?.message;
  return message ? `The session could not start: ${message}` : "The session could not start.";
}

export interface SocketHandlerDeps {
  ctx: StoreAccessors;
  /** Replays queued init-time envelopes once `session.initialized` lands. */
  flushQueuedInitActions: (sessionId: string) => void;
  /** Drops the init queue once the backend refuses `session.init`. */
  failQueuedInit: (sessionId: string, message: string) => void;
}

/**
 * Handle one raw socket frame for a session. Never drops silently: an
 * unparseable frame or a `handleEnvelope` throw surfaces an inline error block
 * (a lost stream chunk otherwise shows up as text stopping mid-message with no
 * clue). Stream deltas are buffered into the coalescer; every other envelope
 * flushes the pending buffer first so it can never overtake preceding deltas.
 */
export function handleSocketMessage(
  deps: SocketHandlerDeps,
  sessionId: string,
  data: string,
): void {
  const { ctx } = deps;
  let envelope: WsEnvelope;
  try {
    envelope = parseEnvelope(data);
  } catch (err) {
    console.warn("[ws-session] dropping unparseable envelope:", err);
    // Flush pending deltas first so the error block lands after the text it
    // follows, not before a frame's worth of buffered tokens.
    flushStreamDeltas(ctx, sessionId);
    const session = ctx.getSession(sessionId);
    ctx.set(
      updateSession(
        ctx.get(),
        sessionId,
        appendErrorBlockPatch(
          session,
          "A streamed update from the agent was unreadable and could not be displayed. The transcript above may be incomplete.",
          { code: "UNPARSEABLE_ENVELOPE" },
        ),
      ),
    );
    return;
  }

  // Coalesce a burst of stream deltas into one commit per frame (see
  // ws-delta-coalescer.ts). Every other envelope flushes the pending buffer.
  if (isStreamDeltaEnvelope(envelope)) {
    bufferStreamDelta(ctx, sessionId, envelope.payload);
    return;
  }
  flushStreamDeltas(ctx, sessionId);
  try {
    handleEnvelope(ctx, sessionId, envelope);
    if (envelope.domain === "session" && envelope.action === SESSION_ACTION.initialized) {
      deps.flushQueuedInitActions(sessionId);
    } else if (isInitRefusal(ctx, sessionId, envelope)) {
      deps.failQueuedInit(sessionId, initRefusalMessage(envelope.payload));
    }
  } catch (err) {
    console.error("[ws-session] handleEnvelope error:", err);
    const session = ctx.getSession(sessionId);
    const errorBlock = makeErrorBlock(
      session,
      `Internal error: ${apiErrorMessage(err, "unknown")}`,
    );
    ctx.set(
      updateSession(
        ctx.get(),
        sessionId,
        blocksPatchWithDerived(session.streamingState, [...session.blocks, errorBlock]),
      ),
    );
  }
}
