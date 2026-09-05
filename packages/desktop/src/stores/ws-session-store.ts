import { create, type StoreApi } from "zustand";
import {
  type PromptDispatchOptions,
  type WsEnvelope,
  createSessionInit,
  createPromptSend,
  createPermissionRespond,
} from "@/lib/ws-envelope";
import * as branch from "./ws-session-branch";
import type { BranchDeps } from "./ws-session-branch";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import {
  makeErrorBlock,
  buildQueuedInitEnvelopes,
  buildQueuedPromptPatch,
} from "./ws-session-store-helpers";
import {
  type SessionEntry,
  type WsSessionStore,
  createSessionEntry,
  updateSession,
} from "./ws-session-types";
import type { AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import { buildAskUserQuestionUpdatedInput } from "@/lib/build-ask-user-question-payload";
import { isTurnActive, transitionTurn } from "./ws-turn-lifecycle";
import { advancePendingPermissionQueue } from "@/lib/pending-permission-queue";
import type { SocketHandlerDeps } from "./ws-session-socket-handler";
import { connectSession } from "./ws-session-connect";
import { createWsSessionSimpleActions } from "./ws-session-simple-actions";
import { createWsSessionTransportActions } from "./ws-session-transport-actions";
import { createWsSessionConfigActions } from "./ws-session-config-actions";

import { blocksPatchWithDerived } from "./ws-message-processing";
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

function sendRawEnvelope(get: WsStoreGet, sessionId: string, envelope: WsEnvelope): void {
  const session = get().sessions[sessionId];
  if (session?.conn?.sendJson(envelope)) return;
  session?.outboundQueue.push(envelope);
}

function flushOutboundQueue(get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (!session?.conn) return;
  const queue = session.outboundQueue;
  let sent = 0;
  while (sent < queue.length && session.conn.sendJson(queue[sent])) sent += 1;
  if (sent > 0) queue.splice(0, sent);
}

function forceReconnectSession(set: WsStoreSet, get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (session?.conn) {
    rejectPendingRequests(session);
    session.conn.close(1000, "force-reconnect");
    set(updateSession(get(), sessionId, { conn: null, isConnected: false }));
  }
  get().connect(sessionId);
}

function flushQueuedInitActions(set: WsStoreSet, get: WsStoreGet, sessionId: string): void {
  const session = get().sessions[sessionId];
  if (!session || !session.serverSessionId) return;
  for (const envelope of buildQueuedInitEnvelopes(session)) {
    sendRawEnvelope(get, sessionId, envelope);
  }
  if (session.queuedPrompts.length === 0) return;
  set(updateSession(get(), sessionId, { queuedPrompts: [] }));
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

function handlePermissionResponse(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  currentRequestId: string,
  payload: unknown,
): void {
  const session = getSessionEntry(get, sessionId);
  const error = parseErrorPayload(payload);
  if (error?.message || payload === null) {
    const message = error?.message ?? "Permission response timed out.";
    const errorBlock = makeErrorBlock(session, message, { idPrefix: "ws-permission-error" });
    const isDeadSessionError = isGateClosingErrorCode(error?.code);
    const responseUuids = new Map(session.permissionResponseMessageUuids);
    if (isDeadSessionError) responseUuids.delete(currentRequestId);
    const gatePatch: Partial<SessionEntry> = isDeadSessionError
      ? {
          ...buildClearedGatePatch(session),
          lifecycle: transitionTurn(session.lifecycle, { type: "turn_errored", message }),
        }
      : { submittingPermissionRequestId: null };
    set(
      updateSession(get(), sessionId, {
        ...blocksPatchWithDerived(session.streamingState, [...session.blocks, errorBlock]),
        ...gatePatch,
        permissionResponseMessageUuids: responseUuids,
      }),
    );
    return;
  }
  const responseUuids = new Map(session.permissionResponseMessageUuids);
  responseUuids.delete(currentRequestId);
  const permissionPatch = advancePendingPermissionQueue(session.pendingPermissionQueue);
  set(
    updateSession(get(), sessionId, {
      ...permissionPatch,
      pendingRequestId: permissionPatch.pendingPermission?.requestId ?? "",
      submittingPermissionRequestId: null,
      permissionResponseMessageUuids: responseUuids,
    }),
  );
}

function createPermissionActions(
  set: WsStoreSet,
  get: WsStoreGet,
): Pick<WsSessionStore, "respondToPermission" | "respondToQuestion"> {
  return {
    respondToPermission(sessionId, requestId, decision, feedback, optionId) {
      const session = getSessionEntry(get, sessionId);
      const currentRequestId = session.pendingPermission?.requestId ?? requestId;
      if (session.submittingPermissionRequestId === currentRequestId) return;
      const permissionResponseMessageUuids = new Map(session.permissionResponseMessageUuids);
      const messageUuid =
        permissionResponseMessageUuids.get(currentRequestId) ?? crypto.randomUUID();
      permissionResponseMessageUuids.set(currentRequestId, messageUuid);
      const envelope = createPermissionRespond(
        session.serverSessionId,
        currentRequestId,
        decision,
        { feedback, optionId, messageUuid },
      );
      set(
        updateSession(get(), sessionId, {
          submittingPermissionRequestId: currentRequestId,
          permissionResponseMessageUuids,
        }),
      );
      void get()
        .sendRequest(sessionId, envelope)
        .then((payload) =>
          handlePermissionResponse(set, get, sessionId, currentRequestId, payload),
        );
    },
    respondToQuestion(sessionId, response: AgentQuestionAnswers) {
      const session = getSessionEntry(get, sessionId);
      sendRawEnvelope(
        get,
        sessionId,
        createPermissionRespond(session.serverSessionId, session.pendingRequestId, "allow_once", {
          updatedInput: buildAskUserQuestionUpdatedInput(
            session.pendingQuestionToolInput,
            response,
          ),
          messageUuid: crypto.randomUUID(),
        }),
      );
      set(
        updateSession(get(), sessionId, {
          pendingQuestions: [],
          pendingQuestionToolInput: {},
          pendingRequestId: "",
          lifecycle: transitionTurn(session.lifecycle, { type: "question_answered" }),
        }),
      );
    },
  };
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

function createPromptActions(set: WsStoreSet, get: WsStoreGet): Pick<WsSessionStore, "sendPrompt"> {
  return {
    sendPrompt(sessionId, text, options: PromptDispatchOptions = {}) {
      const session = getSessionEntry(get, sessionId);
      const messageUuid = options.messageUuid ?? crypto.randomUUID();
      if (session.serverSessionId) {
        sendRawEnvelope(
          get,
          sessionId,
          createPromptSend(session.serverSessionId, text, {
            ...options,
            messageUuid,
            trackPromptReceipt: shouldTrackPromptReceipt(session),
          }),
        );
        return;
      }
      set(
        updateSession(
          get(),
          sessionId,
          buildQueuedPromptPatch(session, text, { ...options, messageUuid }),
        ),
      );
    },
  };
}

function createWsSessionStore(set: WsStoreSet, get: WsStoreGet): WsSessionStore {
  const getSession = (sessionId: string): SessionEntry => getSessionEntry(get, sessionId);
  const sendRaw = (sessionId: string, envelope: WsEnvelope): void =>
    sendRawEnvelope(get, sessionId, envelope);
  const ctx: StoreAccessors = { get, set, getSession };
  const branchDeps: BranchDeps = {
    get,
    set,
    sendRequest: (sessionId, envelope) => get().sendRequest(sessionId, envelope),
  };
  const socketDeps: SocketHandlerDeps = {
    ctx,
    flushQueuedInitActions: (sessionId) => flushQueuedInitActions(set, get, sessionId),
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
      sourceKey: wsSessionSourceKey,
      rejectPendingRequests,
      planRestorePrefix: PLAN_RESTORE_PREFIX,
    }),
  };
}

export const useWsSessionStore = create<WsSessionStore>(createWsSessionStore);
