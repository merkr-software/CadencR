import { translateUi } from "@/lib/i18n/ui";
import {
  createAccessModeSet,
  createCommandsGet,
  createEffortSet,
  createFastModeSet,
  createSessionEnvelope,
  createGateClose,
  createInterrupt,
  createModeSet,
  createModelSet,
  createProfileSet,
  createRuntimeOverridesSet,
  createProviderSet,
  createSessionClear,
  createSessionCompact,
  createSessionSuspend,
  type GateCloseReason,
  type RuntimeConfigOverridePatch,
  type WsEnvelope,
  type RuntimeSettingOverride,
} from "@/lib/ws-envelope";
import { DEFAULT_PROMPT_COMMAND_POLICY } from "@/lib/prompt-command-policy";
import type { AccessMode } from "@/types/access-mode";
import { submitPlanDecision } from "./ws-session-plan-actions";
import { createHistoryActions } from "./ws-session-history-actions";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildSlashCommandsKey } from "./ws-session-store-helpers";
import type { PermissionMode, WsSessionStore } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { SESSION_COMMANDS, settleInterrupt, type SessionCommandSpec } from "./ws-session-commands";

type SimpleSessionActions = Pick<
  WsSessionStore,
  | "interrupt"
  | "settleInterrupt"
  | "suspendForSleep"
  | "clearSession"
  | "compactSession"
  | "setProvider"
  | "setModel"
  | "setThinkingEffort"
  | "setFastMode"
  | "setProfile"
  | "setRuntimeOverrides"
  | "queueRuntimeOverride"
  | "setPermissionMode"
  | "setAccessMode"
  | "approvePlan"
  | "requestPlanChanges"
  | "closeGate"
  | "retryWorktreeSetup"
  | "requestSlashCommands"
  | "markPersistedLoaded"
  | "failPersistedLoad"
  | "retryPersistedLoad"
  | "setPersistedState"
  | "hydratePersistedState"
  | "fillHistoryGap"
  | "loadPromptTurn"
  | "refreshSessionMessages"
>;

interface SimpleSessionActionDeps {
  ctx: StoreAccessors;
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void;
  /** Tracked request/acknowledgement path; see `ws-session-commands`. */
  sendCommand: (sessionId: string, envelope: WsEnvelope, spec: SessionCommandSpec) => boolean;
}

export function createWsSessionSimpleActions(deps: SimpleSessionActionDeps): SimpleSessionActions {
  return {
    ...createLifecycleActions(deps),
    ...createConfigurationActions(deps),
    ...createRuntimeOverrideActions(deps),
    ...createWorkflowActions(deps),
    ...createHistoryActions(deps.ctx),
  };
}

function createLifecycleActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendRaw, sendCommand } = deps;
  const { get, set, getSession } = ctx;
  return {
    interrupt(sessionId: string) {
      const session = getSession(sessionId);
      if (session.pendingCommandActions.includes("interrupt")) return;
      sendCommand(sessionId, createInterrupt(session.serverSessionId), SESSION_COMMANDS.interrupt);
    },

    settleInterrupt(sessionId: string) {
      settleInterrupt(ctx, sessionId);
    },

    suspendForSleep(sessionId: string) {
      const session = getSession(sessionId);
      sendCommand(
        sessionId,
        createSessionSuspend(session.serverSessionId),
        SESSION_COMMANDS.suspend,
      );
    },

    clearSession(sessionId: string) {
      const session = getSession(sessionId);
      sendCommand(sessionId, createSessionClear(session.serverSessionId), SESSION_COMMANDS.clear);
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
  };
}

function createConfigurationActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendCommand } = deps;
  const { get, set, getSession } = ctx;
  return {
    setProvider(sessionId: string, providerId: string, modelId?: string) {
      const session = getSession(sessionId);
      sendCommand(
        sessionId,
        createProviderSet(session.serverSessionId, providerId, modelId),
        SESSION_COMMANDS.provider,
      );
    },

    setModel(sessionId: string, modelId: string, providerId: string) {
      const session = getSession(sessionId);
      sendCommand(
        sessionId,
        createModelSet(session.serverSessionId, modelId, providerId),
        SESSION_COMMANDS.model,
      );
    },

    setThinkingEffort(sessionId: string, thinkingEffort?: string) {
      const session = getSession(sessionId);
      sendCommand(
        sessionId,
        createEffortSet(session.serverSessionId, thinkingEffort),
        SESSION_COMMANDS.effort,
      );
      // No optimistic update: `currentThinkingEffort` is set only once the
      // backend confirms via `effortSetOk` (see ws-envelope-handler.ts).
    },

    async setFastMode(sessionId: string, enabled: boolean): Promise<void> {
      const session = getSession(sessionId);
      if (!session.serverSessionId)
        throw new Error(
          translateUi("conversation.session.notInitialized", "Session is not initialized yet"),
        );
      // A setting like `model.set`: the latest one waits for a reconnect, and
      // `fastMode` changes only on the correlated `fast_mode.set.ok`.
      sendCommand(
        sessionId,
        createFastModeSet(session.serverSessionId, enabled),
        SESSION_COMMANDS.fastMode,
      );
    },

    setProfile(sessionId: string, profile: string) {
      const session = getSession(sessionId);
      if (!session.serverSessionId) return;
      sendCommand(
        sessionId,
        createProfileSet(session.serverSessionId, profile),
        SESSION_COMMANDS.profile,
      );
    },
    setPermissionMode(sessionId: string, mode: PermissionMode) {
      const session = getSession(sessionId);
      if (session.serverSessionId) {
        // Live session: backend owns the truth. Send `mode.set` and let
        // the resulting `mode.changed` envelope drive the chip — that's
        // the only signal that the live CLI actually accepted the new
        // mode (vs. e.g. MODE_NOT_SUPPORTED rejection). No optimistic
        // local write here (see no-optimistic-updates.md).
        sendCommand(sessionId, createModeSet(session.serverSessionId, mode), SESSION_COMMANDS.mode);
        return;
      }
      // Pre-init: there's no CLI to be out of sync with. Hold the
      // selection locally so `buildQueuedInitEnvelopes` can replay it as
      // a `mode.set` once the backend session comes up.
      set(
        updateSession(get(), sessionId, { permissionMode: mode, pendingInitPermissionMode: mode }),
      );
    },

    setAccessMode(sessionId: string, mode: AccessMode) {
      const session = getSession(sessionId);
      if (session.serverSessionId) {
        sendCommand(
          sessionId,
          createAccessModeSet(session.serverSessionId, mode),
          SESSION_COMMANDS.accessMode,
        );
        return;
      }
      set(updateSession(get(), sessionId, { accessMode: mode, pendingInitAccessMode: mode }));
    },
  };
}

/** Model, effort and fast mode for providers that take them as runtime overrides (Codex). */
function createRuntimeOverrideActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendCommand } = deps;
  const { get, set, getSession } = ctx;
  return {
    async setRuntimeOverrides(sessionId: string, patch: RuntimeConfigOverridePatch) {
      const session = getSession(sessionId);
      if (!session.serverSessionId || session.runtimeOverridesPending) return;
      set(updateSession(get(), sessionId, { runtimeOverridesPending: true }));
      try {
        const payload = await get().sendRequest(
          sessionId,
          createRuntimeOverridesSet(session.serverSessionId, patch),
        );
        const error = parseErrorPayload(payload);
        if (error?.message || payload === null) {
          throw new Error(
            error?.message ??
              translateUi(
                "conversation.config.overrideTimeout",
                "Runtime override update timed out",
              ),
          );
        }
      } finally {
        set(updateSession(get(), sessionId, { runtimeOverridesPending: false }));
      }
    },

    queueRuntimeOverride(sessionId: string, setting: RuntimeSettingOverride) {
      const session = getSession(sessionId);
      if (!session.serverSessionId) return;
      sendCommand(
        sessionId,
        createRuntimeOverridesSet(session.serverSessionId, setting),
        runtimeOverrideSpec(setting),
      );
    },
  };
}

function runtimeOverrideSpec(setting: RuntimeSettingOverride): SessionCommandSpec {
  if ("model" in setting) return SESSION_COMMANDS.runtimeModel;
  if ("fast_mode" in setting) return SESSION_COMMANDS.fastMode;
  return SESSION_COMMANDS.runtimeEffort;
}

function createWorkflowActions(deps: SimpleSessionActionDeps) {
  const { ctx, sendRaw, sendCommand } = deps;
  const { get, set, getSession } = ctx;
  return {
    approvePlan(sessionId: string) {
      submitPlanDecision(ctx, sessionId, "approved", "");
    },

    requestPlanChanges(sessionId: string, feedback: string) {
      submitPlanDecision(ctx, sessionId, "rejected", feedback);
    },

    closeGate(sessionId: string, reason: GateCloseReason) {
      const session = getSession(sessionId);
      if (!session.serverSessionId) return;
      const requestId =
        session.pendingRequestId ||
        session.pendingPermission?.requestId ||
        session.pendingPermissionQueue[0]?.requestId ||
        null;
      sendCommand(
        sessionId,
        createGateClose(session.serverSessionId, requestId, reason),
        SESSION_COMMANDS.gateClose,
      );
    },

    retryWorktreeSetup(sessionId: string) {
      const session = getSession(sessionId);
      const featureId = session.featureId;
      if (!featureId) {
        set(
          updateSession(get(), sessionId, {
            worktreeStatus: "setup_error",
            worktreeError: translateUi(
              "conversation.worktree.featureIdRequired",
              "feature_id is required",
            ),
          }),
        );
        return;
      }
      const envelope = createSessionEnvelope("retry_worktree_setup", {
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

    requestSlashCommands(sessionId: string, cwd: string, provider: string, profile?: string) {
      const session = getSession(sessionId);
      const nextKey = buildSlashCommandsKey(cwd, provider, profile);
      const sameTarget = session.slashCommandsKey === nextKey;
      if (sameTarget && session.slashCommandsLoading) {
        return;
      }
      const envelope = createCommandsGet(cwd, provider, profile);
      set(
        updateSession(get(), sessionId, {
          slashCommands: sameTarget ? session.slashCommands : [],
          promptCommandPolicy: sameTarget
            ? session.promptCommandPolicy
            : DEFAULT_PROMPT_COMMAND_POLICY,
          slashCommandsLoading: true,
          slashCommandsError: sameTarget ? session.slashCommandsError : null,
          slashCommandsKey: nextKey,
          slashCommandsRequestRef: envelope.id,
        }),
      );
      sendRaw(sessionId, envelope);
    },
  };
}
