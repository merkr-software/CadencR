import {
  parseEndedPayload,
  parseStreamStatusPayload,
  parseUsagePayload,
} from "./ws-envelope-payload";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn, type TurnTerminalReason } from "./ws-turn-lifecycle";
import { removePendingPromptBlocks, trimTailPromptTurnBoundary } from "./ws-pending-prompts";
import type { StoreAccessors } from "./ws-envelope-types";

/**
 * `session.stream_status` envelope handler. The backend emits this when
 * the underlying transport for an agent stream goes degraded or recovers
 * (today only OpenCode emits transitions away from `"ok"`). The shape is
 * provider-neutral. PR-A wires the store flag; PR-C will render an
 * inline "Reconnecting…" banner under the loader.
 *
 * This is the user-visible counterpart to plan finding #1: the smoking-
 * gun fix in the SDK now drops subscriber senders on reconnect, the
 * service adapter forwards lifecycle events as `RuntimeStreamStatus`,
 * and we land that here so the UI never silently freezes.
 */
export function handleStreamStatus(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseStreamStatusPayload(payload);
  if (!p) {
    // Surface malformed envelopes — see error-handling.md. Keeping this
    // a console warning (not a toast) since users can't act on it; the
    // backend is misbehaving.
    console.warn("[ws-session] dropped malformed stream_status envelope", {
      payload,
    });
    return;
  }
  const next: SessionEntry["streamHealth"] =
    p.state === "degraded"
      ? { state: "degraded", reason: p.reason, since: Date.now() }
      : { state: "ok", since: Date.now() };
  ctx.set(updateSession(ctx.get(), sessionId, { streamHealth: next }));
}

export function handleUsageUpdate(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const u = parseUsagePayload(payload);
  if (!u) return;
  const session = ctx.getSession(sessionId);
  const contextWindow = u.context_window ?? session.contextUsage?.contextWindow ?? null;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      contextUsage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        contextWindow,
        wasCompacted: session.contextUsage?.wasCompacted ?? false,
      },
    }),
  );
}

export function handleTurnComplete(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const session = ctx.getSession(sessionId);
  if (session.pendingPlanApproval != null) {
    return;
  }
  const state = session.streamingState;
  for (const stream of state.streams.values()) {
    if (!stream.parentToolUseId) {
      continue;
    }
    const parent = state.toolUseIdToBlock.get(stream.parentToolUseId);
    if (parent?.childBlocks) parent.taskComplete = true;
    stream.parentToolUseId = null;
  }

  const tailPromptBoundary = trimTailPromptTurnBoundary(session.blocks);
  const blocks = tailPromptBoundary.shouldTrim
    ? tailPromptBoundary.blocks
    : removePendingPromptBlocks(session.blocks);
  const lifecycle = transitionTurn(session.lifecycle, {
    type: "turn_ended",
    reason: mapTerminalReason(parseEndedPayload(payload)?.reason),
  });
  const shouldClearRuntimeCompacting = session.runtimeCompacting;
  if (
    blocks === session.blocks &&
    lifecycle === session.lifecycle &&
    !shouldClearRuntimeCompacting
  ) {
    return;
  }
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...(blocks === session.blocks ? {} : blocksPatchWithDerived(state, blocks)),
      lifecycle,
      ...(shouldClearRuntimeCompacting ? { runtimeCompacting: false } : {}),
    }),
  );
}

function mapTerminalReason(reason: string | undefined): TurnTerminalReason {
  switch (reason) {
    case "provider_complete":
    case "turn_complete":
      return "completed";
    case "stream_closed":
      return "streamClosed";
    case "turn_cleared":
      return "cleared";
    case "permission_denied":
      return "denied";
    default:
      return "completed";
  }
}
