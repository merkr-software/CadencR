import { create } from "zustand";
import { buildUserMessageContent } from "@/types/agent-types";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import { createWsConnection, type WsConnection } from "@/lib/ws-connection";
import {
  scheduleReconnect,
  resetReconnectState,
  clearReconnect,
  registerReconnector,
  unregisterReconnector,
} from "@/lib/ws-reconnect";
import {
  reportManualReconnectRequired,
  useConnectionStatusStore,
} from "@/stores/connection-status-store";
import {
  type SessionConfig,
  type GateCloseReason,
  type PromptDispatchOptions,
  type WsEnvelope,
  createEnvelope,
  createSessionInit,
  createPromptSend,
  createPermissionRespond,
  createInterrupt,
  createDestroy,
  createProviderSet,
  createModelSet,
  createEffortSet,
  createProfileSet,
  createModeSet,
  createCodexPermissionModeSet,
  createSessionClear,
  createSessionCompact,
  createSessionDelete,
  createCommandsGet,
  createGateClose,
} from "@/lib/ws-envelope";
import * as branch from "./ws-session-branch";
import type { BranchDeps } from "./ws-session-branch";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import {
  applyApprovePlan,
  applyPersistedState,
  applyPlanChangesRequest,
  formatQuestionResponse,
  loadOlderSessionMessages,
  type PersistedStatePayload,
} from "./ws-session-actions";
import {
  appendLocalUserMessage,
  makeErrorBlock,
  buildQueuedInitEnvelopes,
  buildQueuedPromptPatch,
  buildSlashCommandsKey,
} from "./ws-session-store-helpers";
import {
  type SessionEntry,
  type WsSessionStore,
  type ResyncTarget,
  createSessionEntry,
  type PermissionMode,
  updateSession,
} from "./ws-session-types";
import type { AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import type { DisplayRowMode } from "@/components/agentStreamDisplay";
import { buildAskUserQuestionUpdatedInput } from "@/lib/build-ask-user-question-payload";
import type { PermissionDecisionValue } from "@/components/ToolPermissionPrompt";
import { isTurnActive, transitionTurn } from "./ws-turn-lifecycle";
import { advancePendingPermissionQueue } from "@/lib/pending-permission-queue";
import type { CodexPermissionMode } from "@/types/codex-permission-mode";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import { discardStreamDeltas, flushStreamDeltas } from "./ws-delta-coalescer";
import { handleSocketMessage, type SocketHandlerDeps } from "./ws-session-socket-handler";

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

export const useWsSessionStore = create<WsSessionStore>((set, get) => {
  function getSession(sessionId: string): SessionEntry {
    return get().sessions[sessionId] ?? createSessionEntry();
  }

  function sendRaw(sessionId: string, envelope: WsEnvelope): void {
    const session = get().sessions[sessionId];
    if (session?.conn?.sendJson(envelope)) return;
    // The socket is not OPEN (reconnecting, or still CONNECTING). Dropping the
    // envelope here is silent data loss — a prompt sent during the gap shows
    // up locally but never reaches the agent. Hold it and flush on `onOpen`,
    // after the reconnect `session.init` replay.
    session?.outboundQueue.push(envelope);
  }

  /** Send queued envelopes in order; stop (and keep the rest) if the socket drops again. */
  function flushOutboundQueue(sessionId: string): void {
    const session = get().sessions[sessionId];
    if (!session?.conn) return;
    const queue = session.outboundQueue;
    // Drain by index and splice once at the end: shift() per envelope would
    // reindex the array each time (O(n²) on a long-outage backlog).
    let sent = 0;
    while (sent < queue.length && session.conn.sendJson(queue[sent])) sent += 1;
    if (sent > 0) queue.splice(0, sent);
  }

  function forceReconnectSession(sessionId: string): void {
    const session = get().sessions[sessionId];
    if (session?.conn) {
      rejectPendingRequests(session);
      session.conn.close(1000, "force-reconnect");
      set(updateSession(get(), sessionId, { conn: null, isConnected: false }));
    }
    get().connect(sessionId);
  }

  function queuePrompt(sessionId: string, text: string, options: PromptDispatchOptions = {}): void {
    const session = getSession(sessionId);
    set(updateSession(get(), sessionId, buildQueuedPromptPatch(session, text, options)));
  }

  function flushQueuedInitActions(sessionId: string): void {
    const session = get().sessions[sessionId];
    if (!session || !session.serverSessionId) return;
    for (const envelope of buildQueuedInitEnvelopes(session)) {
      sendRaw(sessionId, envelope);
    }
    if (session.queuedPrompts.length === 0) return;
    set(updateSession(get(), sessionId, { queuedPrompts: [] }));
  }

  /**
   * Re-emit `session.init` after a transport reconnect so the backend's
   * per-connection `sdk_sessions` map gets rebuilt for this session id.
   *
   * Only fires when:
   *  - We already have a `featureId` (the init payload requires it).
   *  - This is a reconnect, not the first connect — detected by the
   *    presence of a previously-established `serverSessionId`.
   *
   * Provider-neutral: replays whatever provider/model/effort/mode the
   * session was last using. The backend `session.init` handler is
   * idempotent for an existing DB session — it re-binds the in-memory
   * handle from the DB row rather than creating a new one.
   */
  function reinitOnReconnect(sessionId: string): void {
    const session = get().sessions[sessionId];
    if (!session) return;
    if (!session.featureId || !session.serverSessionId || !session.cwd) return;
    sendRaw(
      sessionId,
      createSessionInit({
        cwd: session.cwd,
        featureId: session.featureId,
        provider: session.currentProviderId || undefined,
        model: session.currentModelId || undefined,
        thinkingEffort: session.currentThinkingEffort,
        permissionMode: session.permissionMode,
      }),
    );
  }
  const ctx: StoreAccessors = { get, set, getSession };

  const branchDeps: BranchDeps = {
    get,
    set,
    sendRequest: (sessionId, envelope) => get().sendRequest(sessionId, envelope),
  };

  const socketDeps: SocketHandlerDeps = { ctx, flushQueuedInitActions };

  return {
    sessions: {},
    branchConfirm: null,
    composerPrefill: null,
    forkNavigation: null,

    rewindToMessage(sessionId: string, messageId: number, confirmDiscard?: boolean) {
      void branch.rewindToMessage(branchDeps, sessionId, messageId, confirmDiscard);
    },
    forkFromMessage(sessionId: string, messageId: number) {
      void branch.forkFromMessage(branchDeps, sessionId, messageId);
    },
    resolveBranchConfirm(confirmed: boolean) {
      branch.resolveBranchConfirm(branchDeps, confirmed);
    },
    consumeComposerPrefill(sessionId: string) {
      if (get().composerPrefill?.sessionId === sessionId) set({ composerPrefill: null });
    },
    consumeForkNavigation(sessionId: string) {
      if (get().forkNavigation?.sessionId === sessionId) set({ forkNavigation: null });
    },

    connect(sessionId: string) {
      const existing = get().sessions[sessionId];
      if (existing?.conn && (existing.conn.isOpen() || existing.conn.isConnecting())) {
        return;
      }

      const entry = existing ?? createSessionEntry();
      const reconnectKey = wsSessionSourceKey(sessionId);
      registerReconnector(reconnectKey, () => forceReconnectSession(sessionId), {
        onManualRequired: reportManualReconnectRequired,
      });
      // A replaced mobile socket can remain registered on the service while its
      // close is in flight, so stale callbacks must not mutate the shared store.
      let conn: WsConnection;
      conn = createWsConnection({
        url: getWsUrl(),
        protocols: getWsProtocols(),
        onOpen: () => {
          if (get().sessions[sessionId]?.conn !== conn) return;
          resetReconnectState(reconnectKey);
          set(updateSession(get(), sessionId, { isConnected: true }));
          useConnectionStatusStore.getState().reportSource(reconnectKey, "connected");
          // If we already have a `serverSessionId`, this is a *reconnect*
          // (e.g. after OS sleep), not a fresh init. The backend's
          // `sdk_sessions` map is per-connection, so the new socket has
          // no idea about this session yet. Re-emit `session.init` with
          // the cached config so the backend rebuilds its in-memory
          // handle from the DB — otherwise every subsequent envelope
          // returns `SESSION_NOT_FOUND` (or, when `serverSessionId` is
          // wiped, the more confusing `INVALID_SESSION_ID`).
          // Provider-neutral: applies to Claude Code, OpenCode, Codex.
          reinitOnReconnect(sessionId);
          // Deliver whatever was sent while the socket was down (prompts,
          // permission responses, session.resume after wake). After the init
          // replay so the backend has rebuilt its handle for this session.
          flushOutboundQueue(sessionId);
          // Catch up on anything the agent streamed while the socket was
          // down (e.g. the mobile client was asleep). WS streaming only
          // delivers live; without this pull the gap is lost forever. Guarded
          // internally to a no-op until the initial load has run.
          void resyncMessagesOnReconnect(ctx, sessionId);
        },
        onClose: (intentional) => {
          if (get().sessions[sessionId]?.conn !== conn) return;
          if (intentional) return;
          // Apply any buffered tokens before the "connection lost" error block
          // so the transcript keeps them in order.
          flushStreamDeltas(ctx, sessionId);
          const session = get().sessions[sessionId];
          if (session) rejectPendingRequests(session);
          const wasRunning = session != null && isTurnActive(session.lifecycle);
          const closedDerived = wasRunning
            ? blocksPatchWithDerived(session.streamingState, [
                ...session.blocks,
                makeErrorBlock(session, "Connection lost while streaming. Reconnecting…", {
                  idPrefix: "ws-err-close",
                }),
              ])
            : { blocks: session?.blocks ?? [] };
          set(
            updateSession(get(), sessionId, {
              conn: null,
              isConnected: false,
              // Do not clear `serverSessionId` or `runtimeSessionId` on a
              // transient close: the WS is just transport between the
              // desktop app and the local service. The `serverSessionId`
              // is a stable DB primary key — wiping it makes the renderer
              // send envelopes with `session_id: ""`, which the backend
              // rejects as `INVALID_SESSION_ID`. The next `onOpen`
              // re-emits `session.init` to rebuild the backend's per-
              // connection handle (see `reinitOnReconnect` above).
              lifecycle: transitionTurn(session?.lifecycle ?? createSessionEntry().lifecycle, {
                type: "connection_lost",
              }),
              ...closedDerived,
            }),
          );
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Session WebSocket lost");
          if (!intentional) scheduleReconnect(reconnectKey, () => get().connect(sessionId));
        },
        onError: (intentional) => {
          if (get().sessions[sessionId]?.conn !== conn) return;
          if (intentional) return;
          flushStreamDeltas(ctx, sessionId);
          const session = get().sessions[sessionId];
          if (session) rejectPendingRequests(session);
          set(
            updateSession(get(), sessionId, {
              conn: null,
              isConnected: false,
              // See onClose above: `serverSessionId` and `runtimeSessionId`
              // are stable across transport hiccups; the reconnect path
              // re-emits `session.init` instead of wiping them.
              lifecycle: transitionTurn(session?.lifecycle ?? createSessionEntry().lifecycle, {
                type: "turn_errored",
              }),
            }),
          );
          useConnectionStatusStore
            .getState()
            .reportSource(reconnectKey, "reconnecting", "Session WebSocket error");
          if (!intentional) scheduleReconnect(reconnectKey, () => get().connect(sessionId));
        },
        onMessage: (data) => {
          if (get().sessions[sessionId]?.conn !== conn) return;
          handleSocketMessage(socketDeps, sessionId, data);
        },
      });

      set({
        sessions: {
          ...get().sessions,
          [sessionId]: {
            ...entry,
            conn,
            streamingState: existing?.streamingState ?? entry.streamingState,
          },
        },
      });
    },

    disconnect(sessionId: string) {
      clearReconnect(wsSessionSourceKey(sessionId));
      unregisterReconnector(wsSessionSourceKey(sessionId));
      useConnectionStatusStore.getState().clearSource(wsSessionSourceKey(sessionId));
      discardStreamDeltas(sessionId);
      const session = get().sessions[sessionId];
      // Deliberate teardown: queued envelopes must not outlive it. Without
      // this, a disconnect while the socket is already down early-returns
      // below (conn is null), the entry survives, and a later connect() would
      // flush stale envelopes (e.g. an old prompt) into a session the user
      // had closed. In-place splice because the queue is mutated in place by
      // design (see SessionEntry.outboundQueue).
      session?.outboundQueue.splice(0);
      // The deliberate close() below skips onClose's pending-request sweep
      // (it early-returns on `intentional`), so resolve in-flight requests now
      // rather than leaving permission/worktree calls hanging until the timeout.
      if (session) rejectPendingRequests(session);
      if (!session?.conn) return;

      if (session.serverSessionId) {
        session.conn.sendJson(createDestroy(session.serverSessionId));
      }
      session.conn.close();

      const { [sessionId]: _, ...rest } = get().sessions;
      set({ sessions: rest });
    },

    send: sendRaw,

    sendRequest(sessionId: string, envelope: WsEnvelope): Promise<unknown> {
      return new Promise((resolve) => {
        const session = get().sessions[sessionId];
        if (!session) {
          resolve(null);
          return;
        }
        // A non-OPEN socket is not an instant failure: sendRaw queues the
        // envelope and the reconnect flush usually lands well inside the
        // timeout window. The timer (and the close handler's pending-request
        // sweep) still bound the wait.
        const timer = setTimeout(() => {
          session.pendingWsRequests.delete(envelope.id);
          // Drop the still-queued envelope too. Otherwise a reconnect after the
          // timeout flushes a request the caller already gave up on — e.g. a
          // permission response the user was told "timed out" would silently
          // reach the backend on the next onOpen.
          const queued = session.outboundQueue.indexOf(envelope);
          if (queued !== -1) session.outboundQueue.splice(queued, 1);
          resolve(null);
        }, 10_000);
        session.pendingWsRequests.set(envelope.id, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
        sendRaw(sessionId, envelope);
      });
    },

    initSession(sessionId: string, config: SessionConfig) {
      const sessionPatch: Partial<SessionEntry> = {};
      if (config.cwd) {
        sessionPatch.cwd = config.cwd;
      }
      if (config.featureId) {
        sessionPatch.featureId = config.featureId;
      }
      if (config.provider) {
        sessionPatch.currentProviderId = config.provider;
      }
      if (config.model) {
        sessionPatch.currentModelId = config.model;
      }
      if (config.thinkingEffort) {
        sessionPatch.currentThinkingEffort = config.thinkingEffort;
      }
      if (Object.keys(sessionPatch).length > 0) {
        set(updateSession(get(), sessionId, sessionPatch));
      }
      sendRaw(sessionId, createSessionInit(config));
    },

    sendPrompt(sessionId: string, text: string, options: PromptDispatchOptions = {}) {
      const session = getSession(sessionId);
      const trackProviderReceipt = shouldTrackPromptReceipt(session);
      // Always correlate the local block with its eventual DB id so rewind/fork
      // light up on it without a reload (the `prompt_persisted` ack echoes this
      // ref). `client_message_id` stays receipt/steering-only — unchanged.
      const userMessageRef = crypto.randomUUID();
      const clientMessageId = trackProviderReceipt ? userMessageRef : undefined;
      if (session.serverSessionId) {
        sendRaw(
          sessionId,
          createPromptSend(session.serverSessionId, text, {
            ...options,
            userMessageRef,
            clientMessageId,
          }),
        );
      } else {
        queuePrompt(sessionId, text, { ...options, userMessageRef });
      }

      const content = buildUserMessageContent(text, options.attachments);
      set(
        updateSession(
          get(),
          sessionId,
          appendLocalUserMessage(session, content, {
            clientMessageId: userMessageRef,
            promptDeliveryState: trackProviderReceipt ? "pending_agent" : undefined,
          }),
        ),
      );
    },

    respondToPermission(
      sessionId: string,
      requestId: string,
      decision: PermissionDecisionValue,
      feedback?: string,
      optionId?: string,
    ) {
      const session = getSession(sessionId);
      const currentRequestId = session.pendingPermission?.requestId ?? requestId;
      // Belt-and-braces: the UI also disables buttons while a submission is
      // in flight, but if anything slips through (keyboard shortcut race,
      // remount, etc.) we still want to drop the duplicate request.
      if (session.submittingPermissionRequestId === currentRequestId) {
        return;
      }
      const envelope = createPermissionRespond(
        session.serverSessionId,
        currentRequestId,
        decision,
        {
          feedback,
          optionId,
        },
      );
      set(
        updateSession(get(), sessionId, {
          submittingPermissionRequestId: currentRequestId,
        }),
      );
      void get()
        .sendRequest(sessionId, envelope)
        .then((payload) => {
          const error = parseErrorPayload(payload);
          if (error?.message || payload === null) {
            const session = getSession(sessionId);
            const message = error?.message ?? "Permission response timed out.";
            const errorBlock = makeErrorBlock(session, message, {
              idPrefix: "ws-permission-error",
            });
            // If the backend says the session/permission is unanswerable,
            // drop the gate so the user is not staring at buttons that
            // will only ever bounce back the same error. Timeouts (payload
            // === null) leave the gate in place — the WS reconnects and a
            // retry can still land.
            const isDeadSessionError = isGateClosingErrorCode(error?.code);
            const gatePatch: Partial<SessionEntry> = isDeadSessionError
              ? {
                  ...buildClearedGatePatch(session),
                  lifecycle: transitionTurn(session.lifecycle, {
                    type: "turn_errored",
                    message,
                  }),
                }
              : { submittingPermissionRequestId: null };
            set(
              updateSession(get(), sessionId, {
                ...blocksPatchWithDerived(session.streamingState, [...session.blocks, errorBlock]),
                ...gatePatch,
              }),
            );
            return;
          }
          const session = getSession(sessionId);
          const permissionPatch = advancePendingPermissionQueue(session.pendingPermissionQueue);
          set(
            updateSession(get(), sessionId, {
              ...permissionPatch,
              pendingRequestId: permissionPatch.pendingPermission?.requestId ?? "",
              submittingPermissionRequestId: null,
            }),
          );
        });
    },

    respondToQuestion(sessionId: string, response: AgentQuestionAnswers) {
      const session = getSession(sessionId);
      sendRaw(
        sessionId,
        createPermissionRespond(session.serverSessionId, session.pendingRequestId, "allow_once", {
          updatedInput: buildAskUserQuestionUpdatedInput(
            session.pendingQuestionToolInput,
            response,
          ),
        }),
      );

      const formatted = formatQuestionResponse(session.pendingQuestionToolInput, response);
      session.streamingState.counter += 1;
      const nextBlocks = [
        ...session.blocks,
        {
          id: `ws-user-${session.streamingState.counter}`,
          type: "user_message" as const,
          content: formatted,
          isError: false,
          createdAt: new Date().toISOString(),
        },
      ];
      set(
        updateSession(get(), sessionId, {
          ...blocksPatchWithDerived(session.streamingState, nextBlocks),
          pendingQuestions: [],
          pendingQuestionToolInput: {},
          pendingRequestId: "",
          lifecycle: transitionTurn(session.lifecycle, {
            type: "question_answered",
          }),
        }),
      );
    },

    interrupt(sessionId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createInterrupt(session.serverSessionId));
    },

    destroy(sessionId: string) {
      clearReconnect(wsSessionSourceKey(sessionId));
      unregisterReconnector(wsSessionSourceKey(sessionId));
      useConnectionStatusStore.getState().clearSource(wsSessionSourceKey(sessionId));
      discardStreamDeltas(sessionId);
      const session = get().sessions[sessionId];
      // Same rationale as disconnect(): a destroyed session must not replay
      // its queued envelopes on a future connect, nor leave sendRequest()
      // callers hanging until the timeout after a deliberate close().
      session?.outboundQueue.splice(0);
      if (session) rejectPendingRequests(session);
      if (!session?.conn) return;

      if (session.serverSessionId) {
        session.conn.sendJson(createDestroy(session.serverSessionId));
      }
      session.conn.close();

      set(
        updateSession(get(), sessionId, {
          conn: null,
          isConnected: false,
          lifecycle: transitionTurn(session.lifecycle, {
            type: "turn_ended",
            reason: "completed",
          }),
        }),
      );
    },

    clearSession(sessionId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createSessionClear(session.serverSessionId));
    },

    compactSession(sessionId: string) {
      const session = getSession(sessionId);
      if (session.compactRequestPending || session.pendingManualCompact) return;
      sendRaw(sessionId, createSessionCompact(session.serverSessionId));
      set(
        updateSession(get(), sessionId, {
          ...appendLocalUserMessage(session, "/compact"),
          compactRequestPending: true,
        }),
      );
    },

    deleteSession(sessionId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createSessionDelete(session.serverSessionId));
    },

    setProvider(sessionId: string, providerId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createProviderSet(session.serverSessionId, providerId));
    },

    setModel(sessionId: string, modelId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createModelSet(session.serverSessionId, modelId));
    },

    setThinkingEffort(sessionId: string, thinkingEffort?: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createEffortSet(session.serverSessionId, thinkingEffort));
      set(
        updateSession(get(), sessionId, {
          currentThinkingEffort: thinkingEffort,
        }),
      );
    },

    setProfile(sessionId: string, profile: string) {
      const session = getSession(sessionId);
      if (!session.serverSessionId) return;
      sendRaw(sessionId, createProfileSet(session.serverSessionId, profile));
    },

    setPermissionMode(sessionId: string, mode: PermissionMode) {
      const session = getSession(sessionId);
      if (session.serverSessionId) {
        // Live session: backend owns the truth. Send `mode.set` and let
        // the resulting `mode.changed` envelope drive the chip — that's
        // the only signal that the live CLI actually accepted the new
        // mode (vs. e.g. MODE_NOT_SUPPORTED rejection). No optimistic
        // local write here (see no-optimistic-updates.md).
        sendRaw(sessionId, createModeSet(session.serverSessionId, mode));
        return;
      }
      // Pre-init: there's no CLI to be out of sync with. Hold the
      // selection locally so `buildQueuedInitEnvelopes` can replay it as
      // a `mode.set` once the backend session comes up.
      set(updateSession(get(), sessionId, { permissionMode: mode }));
    },

    setCodexPermissionMode(sessionId: string, mode: CodexPermissionMode) {
      const session = getSession(sessionId);
      if (session.serverSessionId) {
        sendRaw(sessionId, createCodexPermissionModeSet(session.serverSessionId, mode));
        return;
      }
      set(updateSession(get(), sessionId, { codexPermissionMode: mode }));
    },

    approvePlan(sessionId: string) {
      applyApprovePlan(ctx, sessionId, sendRaw, PLAN_RESTORE_PREFIX);
    },

    requestPlanChanges(sessionId: string, feedback: string) {
      applyPlanChangesRequest(ctx, sessionId, feedback, sendRaw, PLAN_RESTORE_PREFIX);
    },

    closeGate(sessionId: string, reason: GateCloseReason) {
      const session = getSession(sessionId);
      if (!session.serverSessionId) return;
      const requestId =
        session.pendingRequestId ||
        session.pendingPermission?.requestId ||
        session.pendingPermissionQueue[0]?.requestId ||
        null;
      sendRaw(sessionId, createGateClose(session.serverSessionId, requestId, reason));
    },

    retryWorktreeSetup(sessionId: string) {
      const session = getSession(sessionId);
      const featureId = session.featureId;
      if (!featureId) {
        set(
          updateSession(get(), sessionId, {
            worktreeStatus: "setup_error",
            worktreeError: "feature_id is required",
          }),
        );
        return;
      }
      const envelope = createEnvelope("session", "retry_worktree_setup", {
        session_id: session.serverSessionId,
        feature_id: featureId,
      });
      void get()
        .sendRequest(sessionId, envelope)
        .then((payload) => {
          const errorMessage = parseErrorPayload(payload)?.message;
          if (!errorMessage) return;
          set(
            updateSession(get(), sessionId, {
              worktreeStatus: "setup_error",
              worktreeError: errorMessage,
            }),
          );
        });
    },

    requestSlashCommands(sessionId: string, cwd: string, provider: string) {
      const session = getSession(sessionId);
      const nextKey = buildSlashCommandsKey(cwd, provider);
      const sameTarget = session.slashCommandsKey === nextKey;
      if (sameTarget && session.slashCommandsLoading) {
        return;
      }
      const envelope = createCommandsGet(cwd, provider);
      set(
        updateSession(get(), sessionId, {
          slashCommands: sameTarget ? session.slashCommands : [],
          slashCommandsLoading: true,
          slashCommandsKey: nextKey,
          slashCommandsRequestRef: envelope.id,
        }),
      );
      sendRaw(sessionId, envelope);
    },

    markPersistedLoaded(sessionId: string) {
      set(updateSession(get(), sessionId, { persistedLoaded: true }));
    },

    setPersistedState(sessionId: string, payload: PersistedStatePayload) {
      applyPersistedState(ctx, sessionId, payload, PLAN_RESTORE_PREFIX);
    },

    async loadOlderMessages(sessionId: string, displayMode?: DisplayRowMode): Promise<number> {
      return loadOlderSessionMessages(ctx, sessionId, displayMode);
    },

    refreshSessionMessages(sessionId: string, target?: ResyncTarget): Promise<void> {
      return resyncMessagesOnReconnect(ctx, sessionId, target);
    },
  };
});
