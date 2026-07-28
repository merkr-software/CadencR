import { toast } from "sonner";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { nextProviderMode } from "@/lib/provider-modes";
import { getEnabledOptInModesFromCache } from "@/hooks/useEnabledOptInModes";
import { type PermissionMode } from "@/types/permission-mode";
import { makeErrorBlock } from "./ws-session-store-helpers";
import { markPendingPromptsFailed, markPromptsReceived } from "./ws-pending-prompts";
import type { StoreAccessors } from "./ws-envelope-types";
import { notifyRateLimited, WS_RATE_LIMIT_RETRY_MS } from "@/lib/ws-reconnect";

/**
 * Error codes whose user mistake originates outside the agent stream (e.g. a
 * meta-bar action). Surfacing these as inline error blocks in the chat is
 * confusing — the user wasn't talking to the agent. Route them to a toast
 * instead, and don't transition the turn lifecycle since no turn was active.
 */
const TOAST_ERROR_CODES = new Set(["MODE_NOT_SUPPORTED"]);
const COMPACT_PRE_START_ERROR_CODES = new Set([
  "COMPACT_REJECTED",
  "SDK_SPAWN_ERROR",
  "UNSUPPORTED_PROVIDER",
]);

export function handleError(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseErrorPayload(payload);

  if (p?.code === "RATE_LIMITED") {
    notifyRateLimited(p.retryAfterMs ?? WS_RATE_LIMIT_RETRY_MS);
    toast.error(p.message ?? "WebSocket message rate exceeded. Reconnecting shortly.");
    return;
  }

  if (p?.code && TOAST_ERROR_CODES.has(p.code) && p.message) {
    toast.error(p.message);
    return;
  }

  // CLI refused a specific permission mode (e.g. Claude Code `auto` on a
  // non-auto-capable model). The payload carries the rejected wire mode;
  // skip past it in the Shift+Tab cycle so the chip isn't stuck.
  if (p?.code === "MODE_REJECTED_BY_CLI" && p.mode) {
    handleModeRejectedByCli(ctx, sessionId, p.mode as PermissionMode, p.message);
    return;
  }

  const session = ctx.getSession(sessionId);
  const gatePatch = isGateClosingErrorCode(p?.code) ? buildClearedGatePatch(session) : null;
  const compactWasRejectedBeforeStart =
    session.compactRequestPending &&
    !session.pendingManualCompact &&
    p?.code !== undefined &&
    COMPACT_PRE_START_ERROR_CODES.has(p.code);
  const compactFailedAfterStart = session.pendingManualCompact && p?.code === "COMPACT_ERROR";
  const turnErroredPatch: Partial<SessionEntry> = {
    lifecycle: transitionTurn(session.lifecycle, {
      type: "turn_errored" as const,
      ...(p?.message ? { message: p.message } : {}),
    }),
    compactRequestPending: false,
    pendingManualCompact: false,
    runtimeCompacting: false,
  };
  // A manual compaction holds the prompt turn — a follow-up `prompt.send` while
  // compacting fails the steering RPC and the backend emits `session.error`,
  // but the underlying compaction is still running. Surface the error inline
  // (so the user sees what happened) without flipping the turn to `error` or
  // clearing the compaction flag — both of those would lie about the agent
  // having stopped.
  let lifecyclePatch: Partial<SessionEntry>;
  if (compactWasRejectedBeforeStart) {
    lifecyclePatch = { compactRequestPending: false, pendingManualCompact: false };
  } else if (compactFailedAfterStart) {
    lifecyclePatch = turnErroredPatch;
  } else if (session.pendingManualCompact) {
    lifecyclePatch = {};
  } else {
    lifecyclePatch = turnErroredPatch;
  }
  const receivedBlocks = markPromptsReceived(session.blocks, p?.receivedPromptMessageUuids ?? []);
  const resolvedBlocks = markPendingPromptsFailed(receivedBlocks);
  if (!p?.message) {
    const blocksPatch =
      resolvedBlocks === session.blocks
        ? {}
        : blocksPatchWithDerived(session.streamingState, resolvedBlocks);
    const patch = { ...lifecyclePatch, ...blocksPatch, ...gatePatch };
    if (Object.keys(patch).length === 0) return;
    ctx.set(updateSession(ctx.get(), sessionId, patch));
    return;
  }
  const errorBlock = makeErrorBlock(session, p.message, { code: p.code });
  const blocks = [...resolvedBlocks, errorBlock];
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...lifecyclePatch,
      ...blocksPatchWithDerived(session.streamingState, blocks),
      ...gatePatch,
    }),
  );
}

function handleModeRejectedByCli(
  ctx: StoreAccessors,
  sessionId: string,
  rejectedMode: PermissionMode,
  rejectedMessage?: string,
): void {
  if (rejectedMode !== "auto") {
    toast.error(rejectedMessage ?? `${rejectedMode} mode was rejected by the provider.`);
    return;
  }

  const session = ctx.get().sessions[sessionId];
  if (!session) return;
  const providerId = session.currentProviderId || session.runtimeProvider;
  const optInModes = getEnabledOptInModesFromCache(providerId ?? "");
  const next = nextProviderMode(providerId, rejectedMode, optInModes);
  if (next === rejectedMode) return;
  ctx.get().setPermissionMode(sessionId, next);
}
