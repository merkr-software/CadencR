import { create } from "zustand";
import { buildUserMessageContent } from "@/types/agent-types";
import { getWsProtocols, getWsUrl } from "@/lib/ws-url";
import { createWsConnection } from "@/lib/ws-connection";
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
  type WsEnvelope,
  parseEnvelope,
  createEnvelope,
  createSessionInit,
  createPromptSend,
  createPermissionRespond,
  createInterrupt,
  createDestroy,
  createProviderSet,
  createModelSet,
  createEffortSet,
  createModeSet,
  createSessionClear,
  createSessionCompact,
  createSessionDelete,
  createCommandsGet,
  createGateClose,
} from "@/lib/ws-envelope";
import { handleEnvelope } from "./ws-envelope-handler";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parseErrorPayload } from "./ws-envelope-payload";
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
  buildQueuedInitEnvelopes,
  buildQueuedPromptPatch,
  buildSlashCommandsKey,
} from "./ws-session-store-helpers";
import {
  type SessionEntry,
  type WsSessionStore,
  createSessionEntry,
  type PermissionMode,
  updateSession,
} from "./ws-session-types";
import type { AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import { buildAskUserQuestionUpdatedInput } from "@/lib/build-ask-user-question-payload";
import type { PermissionDecisionValue } from "@/components/ToolPermissionPrompt";
import { isTurnActive, transitionTurn } from "./ws-turn-lifecycle";
import { advancePendingPermissionQueue } from "@/lib/pending-permission-queue";

import { blocksPatchWithDerived, createStreamingState } from "./ws-message-processing";
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

export const useWsSessionStore = create<WsSessionStore>((set, get) => {
  function getSession(sessionId: string): SessionEntry {
    return get().sessions[sessionId] ?? createSessionEntry();
  }

  function sendRaw(sessionId: string, data: unknown): void {
    getSession(sessionId).conn?.sendJson(data);
  }

  function forceReconnectSession(sessionId: string): void {
    const session = get().sessions[sessionId];
    if (session?.conn) {
      if (session.pendingWsRequests.size) {
        for (const cb of session.pendingWsRequests.values()) cb(null);
        session.pendingWsRequests.clear();
      }
      session.conn.close(1000, "force-reconnect");
      set(updateSession(get(), sessionId, { conn: null, isConnected: false }));
    }
    get().connect(sessionId);
  }

  function queuePrompt(
    sessionId: string,
    text: string,
    images?: Array<{ base64: string; mimeType: string }>,
    useWorktree?: boolean,
  ): void {
    const session = getSession(sessionId);
    set(
      updateSession(get(), sessionId, buildQueuedPromptPatch(session, text, images, useWorktree)),
    );
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

  return {
    sessions: {},

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
      const conn = createWsConnection({
        url: getWsUrl(),
        protocols: getWsProtocols(),
        onOpen: () => {
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
        },
        onClose: (intentional) => {
          if (intentional) return;
          const session = get().sessions[sessionId];
          if (session?.pendingWsRequests.size) {
            for (const cb of session.pendingWsRequests.values()) cb(null);
            session.pendingWsRequests.clear();
          }
          const wasRunning = session != null && isTurnActive(session.lifecycle);
          const errorBlock = wasRunning
            ? {
                id: `ws-err-close-${Date.now()}`,
                type: "text" as const,
                content: "Connection lost while streaming. Reconnecting…",
                isError: true,
              }
            : undefined;
          const closedBlocks = errorBlock
            ? [...(session?.blocks ?? []), errorBlock]
            : (session?.blocks ?? []);
          const closedDerived = errorBlock
            ? blocksPatchWithDerived(
                session?.streamingState ?? createStreamingState(),
                closedBlocks,
              )
            : { blocks: closedBlocks };
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
          if (intentional) return;
          const session = get().sessions[sessionId];
          if (session?.pendingWsRequests.size) {
            for (const cb of session.pendingWsRequests.values()) cb(null);
            session.pendingWsRequests.clear();
          }
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
          let envelope: WsEnvelope;
          try {
            envelope = parseEnvelope(data);
          } catch {
            return; // genuinely unparseable — skip
          }
          try {
            handleEnvelope(ctx, sessionId, envelope);
            if (envelope.domain === "session" && envelope.action === "initialized") {
              flushQueuedInitActions(sessionId);
            }
          } catch (err) {
            console.error("[ws-session] handleEnvelope error:", err);
            const session = getSession(sessionId);
            session.streamingState.counter += 1;
            const blocks = [
              ...session.blocks,
              {
                id: `ws-err-${session.streamingState.counter}`,
                type: "text" as const,
                content: `Internal error: ${err instanceof Error ? err.message : "unknown"}`,
                isError: true,
              },
            ];
            set(
              updateSession(
                get(),
                sessionId,
                blocksPatchWithDerived(session.streamingState, blocks),
              ),
            );
          }
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
      const session = get().sessions[sessionId];
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
        if (!session?.conn?.isOpen()) {
          resolve(null);
          return;
        }
        const timer = setTimeout(() => {
          session.pendingWsRequests.delete(envelope.id);
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

    sendPrompt(
      sessionId: string,
      text: string,
      images?: Array<{ base64: string; mimeType: string }>,
      useWorktree?: boolean,
    ) {
      const session = getSession(sessionId);
      const trackProviderReceipt = shouldTrackPromptReceipt(session);
      const clientMessageId = trackProviderReceipt ? crypto.randomUUID() : undefined;
      if (session.serverSessionId) {
        sendRaw(
          sessionId,
          createPromptSend(session.serverSessionId, text, images, useWorktree, clientMessageId),
        );
      } else {
        queuePrompt(sessionId, text, images, useWorktree);
      }

      const content = buildUserMessageContent(text, images);
      set(
        updateSession(
          get(),
          sessionId,
          appendLocalUserMessage(session, content, {
            clientMessageId,
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
            session.streamingState.counter += 1;
            const message = error?.message ?? "Permission response timed out.";
            const blocks = [
              ...session.blocks,
              {
                id: `ws-permission-error-${session.streamingState.counter}`,
                type: "text" as const,
                content: message,
                isError: true,
              },
            ];
            set(
              updateSession(get(), sessionId, {
                ...blocksPatchWithDerived(session.streamingState, blocks),
                submittingPermissionRequestId: null,
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
          lifecycle: transitionTurn(session.lifecycle, { type: "question_answered" }),
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
      const session = get().sessions[sessionId];
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
      if (session.pendingManualCompact) return;
      sendRaw(sessionId, createSessionCompact(session.serverSessionId));
      set(
        updateSession(get(), sessionId, {
          ...appendLocalUserMessage(session, "/compact"),
          pendingManualCompact: true,
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
      set(updateSession(get(), sessionId, { currentThinkingEffort: thinkingEffort }));
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

    async loadOlderMessages(sessionId: string): Promise<number> {
      return loadOlderSessionMessages(ctx, sessionId);
    },
  };
});
