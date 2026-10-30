import { createPermissionActions } from "./ws-session-permission-actions";
import { create, type StateCreator, type StoreApi } from "zustand";
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
import type { SocketHandlerDeps } from "./ws-session-socket-handler";
import { connectSession, initRequestIdAfterDrop } from "./ws-session-connect";
import { createWsSessionSimpleActions } from "./ws-session-simple-actions";
import { createWsSessionTransportActions } from "./ws-session-transport-actions";
import { SessionTransportRegistry } from "./ws-session-transport";
import {
  sessionPresentationEffects,
  type SessionPresentationEffects,
} from "./ws-session-presentation";
export { installSessionPresentationEffects } from "./ws-session-presentation";
export type { SessionPresentationEffects } from "./ws-session-presentation";
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

function shouldTrackPromptReceipt(session: SessionEntry): boolean {
  return (
    session.supportsPromptReceipts && !!session.serverSessionId && isTurnActive(session.lifecycle)
  );
}

type WsStoreSet = StoreApi<WsSessionStore>["setState"];
type WsStoreGet = StoreApi<WsSessionStore>["getState"];

function getSessionEntry(get: WsStoreGet, sessionId: string): SessionEntry {
  return get().sessions[sessionId] ?? createSessionEntry();
}

/** Returns false when the envelope was parked in the outbound queue instead. */
function sendRawEnvelope(ctx: StoreAccessors, sessionId: string, envelope: WsEnvelope): boolean {
  return !!ctx.get().sessions[sessionId] && ctx.transport.send(sessionId, envelope);
}

function forceReconnectSession(ctx: StoreAccessors, sessionId: string): void {
  const { set, get, transport } = ctx;
  const session = get().sessions[sessionId];
  const resources = transport.get(sessionId);
  if (resources?.conn) {
    transport.rejectPendingRequests(sessionId);
    const conn = resources.conn;
    resources.conn = null;
    conn.close(1000, "force-reconnect");
    // The close handler ignores this intentional close, so drop a sent init here.
    set(
      updateSession(get(), sessionId, {
        isConnected: false,
        isConnecting: false,
        initRequestId: initRequestIdAfterDrop(session, resources.outboundQueue),
      }),
    );
  }
  get().connect(sessionId);
}

function flushQueuedInitActions(ctx: StoreAccessors, sessionId: string): void {
  const { set, get, transport } = ctx;
  const session = get().sessions[sessionId];
  if (!session || !session.serverSessionId) return;
  for (const envelope of buildQueuedInitEnvelopes(session)) {
    sendRawEnvelope(ctx, sessionId, envelope);
  }
  transport
    .get(sessionId)
    ?.delivery.settle(session.queuedPrompts.map((prompt) => prompt.messageUuid));
  if (session.queuedPrompts.length === 0 && !session.pendingInitAccessMode) return;
  set(updateSession(get(), sessionId, { queuedPrompts: [], pendingInitAccessMode: null }));
}

/**
 * `session.init` was refused: its queued prompts will never be sent. Awaiting
 * callers get theirs back; fire-and-forget `sendPrompt` callers only see the
 * inline error block. `pendingInitAccessMode` is kept — it is still the
 * user's choice for the next init.
 */
function failQueuedInit(ctx: StoreAccessors, sessionId: string, message: string) {
  ctx.set(updateSession(ctx.get(), sessionId, { queuedPrompts: [], initRequestId: null }));
  ctx.transport.get(sessionId)?.delivery.fail(message);
}

function reinitOnReconnect(ctx: StoreAccessors, sessionId: string): void {
  const { get } = ctx;
  const session = get().sessions[sessionId];
  if (!session?.featureId || !session.serverSessionId || !session.cwd) return;
  sendRawEnvelope(
    ctx,
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
  ctx: StoreAccessors,
  presentation: SessionPresentationEffects,
  sessionId: string,
  text: string,
  options: PromptDispatchOptions,
): string | null {
  const { get, set } = ctx;
  const session = getSessionEntry(get, sessionId);
  if (session.featureId !== null) presentation.onUserPromptDispatched(session.featureId);
  const messageUuid = options.messageUuid ?? crypto.randomUUID();
  if (session.serverSessionId) {
    const envelope = createPromptSend(session.serverSessionId, text, {
      ...options,
      messageUuid,
      trackPromptReceipt: shouldTrackPromptReceipt(session),
    });
    return sendRawEnvelope(ctx, sessionId, envelope) ? null : envelope.id;
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
  ctx: StoreAccessors,
  presentation: SessionPresentationEffects,
): Pick<WsSessionStore, "sendPrompt" | "deliverPrompt"> {
  const { get, transport } = ctx;
  return {
    deliverPrompt(sessionId, text, options: PromptDispatchOptions = {}) {
      // Queueing onto a missing entry is a no-op, so nothing would settle it.
      if (!get().sessions[sessionId]) {
        return Promise.reject(new Error("The session is not connected."));
      }
      const pendingKey = dispatchPrompt(ctx, presentation, sessionId, text, options);
      return pendingKey
        ? transport.ensure(sessionId).delivery.await(pendingKey)
        : Promise.resolve();
    },
    sendPrompt(sessionId, text, options: PromptDispatchOptions = {}) {
      dispatchPrompt(ctx, presentation, sessionId, text, options);
    },
  };
}

function buildWsSessionStore(
  set: WsStoreSet,
  get: WsStoreGet,
  presentation: SessionPresentationEffects,
): WsSessionStore {
  const transport = new SessionTransportRegistry();
  // Global reconnect/status services must distinguish equally named sessions
  // owned by independently initialized stores, including overlapping HMR roots.
  const sourceNamespace = crypto.randomUUID();
  const sourceKey = (sessionId: string): string => `ws-session:${sourceNamespace}:${sessionId}`;
  const getSession = (sessionId: string): SessionEntry => getSessionEntry(get, sessionId);
  const sendRaw = (sessionId: string, envelope: WsEnvelope): void => {
    sendRawEnvelope(ctx, sessionId, envelope);
  };
  const ctx: StoreAccessors = { get, set, getSession, transport };
  const branchDeps: BranchDeps = {
    get,
    set,
    sendRequest: (sessionId, envelope) => get().sendRequest(sessionId, envelope),
  };
  const socketDeps: SocketHandlerDeps = {
    ctx,
    flushQueuedInitActions: (sessionId) => flushQueuedInitActions(ctx, sessionId),
    failQueuedInit: (sessionId, message) => failQueuedInit(ctx, sessionId, message),
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
          sourceKey,
          forceReconnectSession: (id) => forceReconnectSession(ctx, id),
          reinitOnReconnect: (id) => reinitOnReconnect(ctx, id),
          flushOutboundQueue: (id) => transport.flush(id),
        },
        sessionId,
      ),
    ...createWsSessionTransportActions({
      ctx,
      sendRaw,
      sourceKey,
    }),
    ...createWsSessionConfigActions(ctx),
    ...createPromptActions(ctx, presentation),
    ...createPermissionActions(set, get),
    ...createWsSessionSimpleActions({
      ctx,
      sendRaw,
      sourceKey,
      planRestorePrefix: PLAN_RESTORE_PREFIX,
    }),
  };
}

/** A fresh registry is allocated for every initialized store, even if this creator is reused. */
export function createWsSessionStore(
  presentation: SessionPresentationEffects,
): StateCreator<WsSessionStore> {
  return (set, get) => buildWsSessionStore(set, get, presentation);
}

export const useWsSessionStore = create<WsSessionStore>(
  createWsSessionStore(sessionPresentationEffects),
);
