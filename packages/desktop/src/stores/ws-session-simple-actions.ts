import type { DisplayRowMode } from "@/components/agentStreamDisplay";
import {
  createAccessModeSet,
  createCommandsGet,
  createDestroy,
  createEffortSet,
  createFastModeSet,
  createEnvelope,
  createGateClose,
  createInterrupt,
  createModeSet,
  createModelSet,
  createProfileSet,
  createProviderSet,
  createSessionClear,
  createSessionCompact,
  createSessionDelete,
  type GateCloseReason,
  type WsEnvelope,
} from "@/lib/ws-envelope";
import { clearReconnect, unregisterReconnector } from "@/lib/ws-reconnect";
import { DEFAULT_PROMPT_COMMAND_POLICY } from "@/lib/prompt-command-policy";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import type { AccessMode } from "@/types/access-mode";
import {
  applyApprovePlan,
  applyPersistedState,
  applyPlanChangesRequest,
  loadOlderSessionMessages,
} from "./ws-session-actions";
import { discardStreamDeltas } from "./ws-delta-coalescer";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parseErrorPayload, parseFastModePayload } from "./ws-envelope-payload";
import { resyncMessagesOnReconnect } from "./ws-session-resync";
import { buildSlashCommandsKey } from "./ws-session-store-helpers";
import type {
  PermissionMode,
  PersistedStatePayload,
  ResyncTarget,
  SessionEntry,
  WsSessionStore,
} from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";

type SimpleSessionActions = Pick<
  WsSessionStore,
  | "interrupt"
  | "destroy"
  | "clearSession"
  | "compactSession"
  | "deleteSession"
  | "setProvider"
  | "setModel"
  | "setThinkingEffort"
  | "setFastMode"
  | "setProfile"
  | "setPermissionMode"
  | "setAccessMode"
  | "approvePlan"
  | "requestPlanChanges"
  | "closeGate"
  | "retryWorktreeSetup"
  | "requestSlashCommands"
  | "markPersistedLoaded"
  | "setPersistedState"
  | "loadOlderMessages"
  | "refreshSessionMessages"
>;

interface SimpleSessionActionDeps {
  ctx: StoreAccessors;
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void;
  sourceKey: (sessionId: string) => string;
  rejectPendingRequests: (session: SessionEntry) => void;
  planRestorePrefix: string;
}

export function createWsSessionSimpleActions(deps: SimpleSessionActionDeps): SimpleSessionActions {
  return {
    ...createLifecycleActions(deps),
    ...createConfigurationActions(deps),
    ...createWorkflowActions(deps),
  };
}

function createLifecycleActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendRaw, sourceKey, rejectPendingRequests } = deps;
  const { get, set, getSession } = ctx;
  return {
    interrupt(sessionId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createInterrupt(session.serverSessionId));
    },

    destroy(sessionId: string) {
      clearReconnect(sourceKey(sessionId));
      unregisterReconnector(sourceKey(sessionId));
      useConnectionStatusStore.getState().clearSource(sourceKey(sessionId));
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
          compactRequestPending: true,
        }),
      );
    },

    deleteSession(sessionId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createSessionDelete(session.serverSessionId));
    },
  };
}

function createConfigurationActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendRaw } = deps;
  const { get, set, getSession } = ctx;
  return {
    setProvider(sessionId: string, providerId: string, modelId?: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createProviderSet(session.serverSessionId, providerId, modelId));
    },

    setModel(sessionId: string, modelId: string, providerId: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createModelSet(session.serverSessionId, modelId, providerId));
    },

    setThinkingEffort(sessionId: string, thinkingEffort?: string) {
      const session = getSession(sessionId);
      sendRaw(sessionId, createEffortSet(session.serverSessionId, thinkingEffort));
      // No optimistic update: `currentThinkingEffort` is set only once the
      // backend confirms via `effortSetOk` (see ws-envelope-handler.ts).
    },

    async setFastMode(sessionId: string, enabled: boolean): Promise<void> {
      const session = getSession(sessionId);
      if (!session.serverSessionId) throw new Error("Session is not initialized yet");
      const payload = await get().sendRequest(
        sessionId,
        createFastModeSet(session.serverSessionId, enabled),
      );
      const error = parseErrorPayload(payload);
      if (error?.message || payload === null) {
        throw new Error(error?.message ?? "Fast mode update timed out");
      }
      const next = parseFastModePayload(payload);
      if (!next) throw new Error("Fast mode update returned an invalid response");
      set(updateSession(get(), sessionId, { fastMode: next.enabled }));
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

    setAccessMode(sessionId: string, mode: AccessMode) {
      const session = getSession(sessionId);
      if (session.serverSessionId) {
        sendRaw(sessionId, createAccessModeSet(session.serverSessionId, mode));
        return;
      }
      set(updateSession(get(), sessionId, { accessMode: mode }));
    },
  };
}

function createWorkflowActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendRaw, planRestorePrefix } = deps;
  const { get, set, getSession } = ctx;
  return {
    approvePlan(sessionId: string) {
      applyApprovePlan(ctx, sessionId, sendRaw, planRestorePrefix);
    },

    requestPlanChanges(sessionId: string, feedback: string) {
      applyPlanChangesRequest(ctx, sessionId, feedback, sendRaw, planRestorePrefix);
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
          promptCommandPolicy: sameTarget
            ? session.promptCommandPolicy
            : DEFAULT_PROMPT_COMMAND_POLICY,
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
      applyPersistedState(ctx, sessionId, payload, planRestorePrefix);
    },

    async loadOlderMessages(sessionId: string, displayMode?: DisplayRowMode): Promise<number> {
      return loadOlderSessionMessages(ctx, sessionId, displayMode);
    },

    refreshSessionMessages(sessionId: string, target?: ResyncTarget): Promise<void> {
      return resyncMessagesOnReconnect(ctx, sessionId, target);
    },
  };
}
