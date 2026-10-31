import { createPermissionActions } from "./ws-session-permission-actions";
import { create, type StoreApi } from "zustand";
import {
  type PromptDispatchOptions,
  type WsEnvelope,
  createSessionInit,
  createPromptSend,
} from "@/lib/ws-envelope";
import * as branch from "./ws-session-branch";
import type { BranchDeps } from "./ws-session-branch";
import type { StoreAccessors } from "./ws-envelope-handler";
import { buildQueuedInitEnvelopes, buildQueuedPromptPatch } from "./ws-session-store-helpers";
import {
  type SessionEntry,
  type WsSessionStore,
  createSessionEntry,
  updateSession,
} from "./ws-session-types";
import { isTurnActive } from "./ws-turn-lifecycle";
import { noteUserPrompt } from "@/lib/auto-layout/auto-layout-controller";
import { acknowledgeForMe } from "@/stores/for-me-ack";
import type { SocketHandlerDeps } from "./ws-session-socket-handler";
import { connectSession, initRequestIdAfterDrop } from "./ws-session-connect";
import { createWsSessionSimpleActions } from "./ws-session-simple-actions";
import { createWsSessionTransportActions } from "./ws-session-transport-actions";
import {
  awaitPromptDelivery,
  failPromptDelivery,
  settlePromptDelivery,
} from "./ws-session-prompt-delivery";
import { createWsSessionConfigActions } from "./ws-session-config-actions";

export type { PermissionMode, PendingPlanApproval } from "./ws-session-types";
export {
  type StreamingState,
  type BlockMutation,
  blocksPatchWithDerived,
  createStreamingState,
  processSdkMessage,
  applyMutations,
} from "./ws-message-processing";

/** Prefix for synthetic request IDs created during plan-restore flows. */
const PLAN_RESTORE_PREFIX = "plan_restore_";
const wsSessionSourceKey = (sessionId: string): string => `ws-session:${sessionId}`;

function shouldTrackPromptReceipt(session: SessionEntry): boolean {
  return (
    session.supportsPromptReceipts && !!session.serverSessionId && isTurnActive(session.lifecycle)
  );
}

/**
 * Resolve every in-flight `sendRequest()` with `null` and clear the map, so
 * callers stop waiting the moment the socket is gone (transient drop or
 * deliberate teardown) instead of hanging until the 10s timeout.
 *
 * A request resolved as failed must not execute later as a stale side effect:
 * its envelope may still sit in `outboundQueue` (queued while the socket was
 * down), so drop it too. Non-request envelopes (prompts, resume, control)
 * keep the queue-and-flush policy — only rejected requests are removed.
 */
function rejectPendingRequests(session: SessionEntry): void {
  if (!session.pendingWsRequests.size) return;
  const requestIds = new Set(session.pendingWsRequests.keys());
  for (const cb of session.pendingWsRequests.values()) cb(null);
  session.pendingWsRequests.clear();
  const queue = session.outboundQueue;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (requestIds.has(queue[i].id)) queue.splice(i, 1);
  }
}

type WsStoreSet = StoreApi<WsSessionStore>["setState"];
type WsStoreGet = StoreApi<WsSessionStore>["getState"];

function getSessionEntry(get: WsStoreGet, sessionId: string): SessionEntry {
  return get().sessions[sessionId] ?? createSessionEntry();
}

/** Returns false when the envelope was parked in the outbound queue instead. */
function sendRawEnvelope(get: WsStoreGet, sessionId: string, envelope: WsEnvelope): boolean {
  const session = get().sessions[sessionId];
  if (session?.conn?.sendJson(envelope)) return true;
  session?.outboundQueue.push(envelope);
  return false;
}

function flushOutboundQueue(get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (!session?.conn) return;
  const queue = session.outboundQueue;
  let sent = 0;
  while (sent < queue.length && session.conn.sendJson(queue[sent])) sent += 1;
  if (sent === 0) return;
  const flushed = queue.splice(0, sent);
  settlePromptDelivery(
    sessionId,
    flushed.map((envelope) => envelope.id),
  );
}

function forceReconnectSession(set: WsStoreSet, get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (session?.conn) {
    rejectPendingRequests(session);
    session.conn.close(1000, "force-reconnect");
    // The close handler ignores this intentional close, so drop a sent init here.
    set(
      updateSession(get(), sessionId, {
        conn: null,
        isConnected: false,
        initRequestId: initRequestIdAfterDrop(session),
      }),
    );
  }
  get().connect(sessionId);
}

function flushQueuedInitActions(set: WsStoreSet, get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (!session || !session.serverSessionId) return;
  for (const envelope of buildQueuedInitEnvelopes(session)) {
    sendRawEnvelope(get, sessionId, envelope);
  }
  settlePromptDelivery(
    sessionId,
    session.queuedPrompts.map((prompt) => prompt.messageUuid),
  );
  if (session.queuedPrompts.length === 0 && !session.pendingInitAccessMode) return;
  set(updateSession(get(), sessionId, { queuedPrompts: [], pendingInitAccessMode: null }));
}

/**
 * `session.init` was refused: its queued prompts will never be sent. Awaiting
 * callers get theirs back; fire-and-forget `sendPrompt` callers only see the
 * inline error block. `pendingInitAccessMode` is kept — it is still the
 * user's choice for the next init.
 */
function failQueuedInit(set: WsStoreSet, get: WsStoreGet, sessionId: string, message: string) {
  set(updateSession(get(), sessionId, { queuedPrompts: [], initRequestId: null }));
  failPromptDelivery(sessionId, message);
}

function reinitOnReconnect(get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (!session?.featureId || !session.serverSessionId || !session.cwd) return;
  sendRawEnvelope(
    get,
    sessionId,
    createSessionInit({
      cwd: session.cwd,
      featureId: session.featureId,
      provider: session.currentSelection?.providerId || undefined,
      model: session.currentSelection?.modelId || undefined,
      thinkingEffort: session.currentThinkingEffort,
      permissionMode: session.permissionMode,
    }),
  );
}

function createBranchActions(
  set: WsStoreSet,
  get: WsStoreGet,
  branchDeps: BranchDeps,
): Pick<
  WsSessionStore,
  | "rewindToMessage"
  | "forkFromMessage"
  | "resolveBranchConfirm"
  | "consumeComposerPrefill"
  | "consumeForkNavigation"
> {
  return {
    rewindToMessage: (sessionId, messageId, confirmDiscard) => {
      void branch.rewindToMessage(branchDeps, sessionId, messageId, confirmDiscard);
    },
    forkFromMessage: (sessionId, messageId) => {
      void branch.forkFromMessage(branchDeps, sessionId, messageId);
    },
    resolveBranchConfirm: (confirmed) => branch.resolveBranchConfirm(branchDeps, confirmed),
    consumeComposerPrefill: (sessionId) => {
      if (get().composerPrefill?.sessionId === sessionId) set({ composerPrefill: null });
    },
    consumeForkNavigation: (sessionId) => {
      if (get().forkNavigation?.sessionId === sessionId) set({ forkNavigation: null });
    },
  };
}

/**
 * Send the prompt now, or hold it until it can leave. Returns the key its
 * delivery waits on — the init-queue `messageUuid`, or the envelope id when
 * the socket is down and it was parked in the outbound queue — or `null`
 * once it is on the wire.
 */
function dispatchPrompt(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  text: string,
  options: PromptDispatchOptions,
): string | null {
  const session = getSessionEntry(get, sessionId);
  if (session.featureId !== null) {
    noteUserPrompt(session.featureId);
    // Prompting the conversation is acting on what For me asked.
    acknowledgeForMe(session.featureId);
  }
  const messageUuid = options.messageUuid ?? crypto.randomUUID();
  if (session.serverSessionId) {
    const envelope = createPromptSend(session.serverSessionId, text, {
      ...options,
      messageUuid,
      trackPromptReceipt: shouldTrackPromptReceipt(session),
    });
    return sendRawEnvelope(get, sessionId, envelope) ? null : envelope.id;
  }
  set(
    updateSession(
      get(),
      sessionId,
      buildQueuedPromptPatch(session, text, { ...options, messageUuid }),
    ),
  );
  return messageUuid;
}

function createPromptActions(
  set: WsStoreSet,
  get: WsStoreGet,
): Pick<WsSessionStore, "sendPrompt" | "deliverPrompt"> {
  return {
    deliverPrompt(sessionId, text, options: PromptDispatchOptions = {}) {
      // Queueing onto a missing entry is a no-op, so nothing would settle it.
      if (!get().sessions[sessionId]) {
        return Promise.reject(new Error("The session is not connected."));
      }
      const pendingKey = dispatchPrompt(set, get, sessionId, text, options);
      return pendingKey ? awaitPromptDelivery(sessionId, pendingKey) : Promise.resolve();
    },
    sendPrompt(sessionId, text, options: PromptDispatchOptions = {}) {
      dispatchPrompt(set, get, sessionId, text, options);
    },
  };
}

function createWsSessionStore(set: WsStoreSet, get: WsStoreGet): WsSessionStore {
  const getSession = (sessionId: string): SessionEntry => getSessionEntry(get, sessionId);
  const sendRaw = (sessionId: string, envelope: WsEnvelope): void => {
    sendRawEnvelope(get, sessionId, envelope);
  };
  const ctx: StoreAccessors = { get, set, getSession };
  const branchDeps: BranchDeps = {
    get,
    set,
    sendRequest: (sessionId, envelope) => get().sendRequest(sessionId, envelope),
  };
  const socketDeps: SocketHandlerDeps = {
    ctx,
    flushQueuedInitActions: (sessionId) => flushQueuedInitActions(set, get, sessionId),
    failQueuedInit: (sessionId, message) => failQueuedInit(set, get, sessionId, message),
  };
  return {
    sessions: {},
    branchConfirm: null,
    composerPrefill: null,
    forkNavigation: null,
    ...createBranchActions(set, get, branchDeps),
    connect: (sessionId) =>
      connectSession(
        {
          ctx,
          socketDeps,
          sourceKey: wsSessionSourceKey,
          rejectPendingRequests,
          forceReconnectSession: (id) => forceReconnectSession(set, get, id),
          reinitOnReconnect: (id) => reinitOnReconnect(get, id),
          flushOutboundQueue: (id) => flushOutboundQueue(get, id),
        },
        sessionId,
      ),
    ...createWsSessionTransportActions({
      ctx,
      sendRaw,
      sourceKey: wsSessionSourceKey,
      rejectPendingRequests,
    }),
    ...createWsSessionConfigActions(ctx),
    ...createPromptActions(set, get),
    ...createPermissionActions(set, get),
    ...createWsSessionSimpleActions({
      ctx,
      sendRaw,
      planRestorePrefix: PLAN_RESTORE_PREFIX,
    }),
  };
}

export const useWsSessionStore = create<WsSessionStore>(createWsSessionStore);
