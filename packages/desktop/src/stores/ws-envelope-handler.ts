import {
  handleRuntimeOverridesChanged,
  handleRuntimeSessionId,
  handleSessionConfigSnapshot,
  handleAccessModeChanged,
  handleModeChanged,
  handleEffortSetOk,
} from "./ws-envelope-runtime-handlers";
import type { SlashCommand } from "@/lib/slash-command";
import { promptCommandPolicyFromPayload } from "@/lib/prompt-command-policy";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import {
  parseCommandsListPayload,
  parseFeatureAutoNamingPayload,
  parseFeatureRenamePayload,
  parseFeatureUpdatedPayload,
  parseFastModePayload,
  parseLifecyclePayload,
  parseModelPayload,
  parseProviderPayload,
  parseProfilePayload,
} from "./ws-envelope-payload";
import { normalizeContextWindow } from "@/types/agent";
import { truncateBlocksAtMessage } from "./ws-session-branch";
import { handleWorktreeEvent } from "./ws-worktree-handler";
import { useGitStatusStore } from "./useGitStatusStore";
import { isRecord } from "./ws-message-processing";
import { parseAccessMode } from "@/types/access-mode";
import { createSessionConfigState, updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import type { StoreAccessors } from "./ws-envelope-types";
import {
  handleCleared,
  handleCompacting,
  handleGateClosed,
  handleInitialized,
  handleMcpServers,
  handleMessage,
  handlePermissionRequest,
  handlePromptReceived,
  handleCanonicalUserMessage,
} from "./ws-envelope-session-handlers";
import { handleError } from "./ws-envelope-error-handler";
import { handlePersistenceStatus } from "./ws-persistence-status";
import {
  handleStreamStatus,
  handleTurnComplete,
  handleUsageUpdate,
} from "./ws-envelope-turn-handlers";
import {
  SESSION_ACTION,
  LEGACY_SESSION_ACTION,
  type SessionActionName,
  type LegacySessionActionName,
} from "./ws-session-action-names";
import { handleSubagentUpdated, handleTurnEndWithSubagents } from "./ws-subagent-handlers";
import { discardStreamDeltas } from "./ws-delta-coalescer";
import { SESSION_CLOSED_BEFORE_DELIVERY, failPromptDelivery } from "./ws-session-prompt-delivery";
export type { StoreAccessors } from "./ws-envelope-types";

// Main envelope handler

export function handleEnvelope(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { domain: string; action: string; ref?: string; payload: unknown },
): void {
  // Resolve pending request-response callbacks
  if (envelope.ref) {
    const session = ctx.get().sessions[sessionId];
    const cb = session?.pendingWsRequests.get(envelope.ref);
    if (cb) {
      session.pendingWsRequests.delete(envelope.ref);
      cb(envelope.payload);
      // Most correlated replies contain request-only acknowledgements. Runtime
      // override replies are different: the payload is also the canonical
      // confirmed snapshot that drives the visible controls. Apply it after
      // resolving the request rather than waiting for a separate broadcast.
      if (
        envelope.domain !== "session" ||
        envelope.action !== SESSION_ACTION.runtime_overrideschanged
      ) {
        return;
      }
    }
  }

  if (envelope.domain === "commands") {
    handleCommandsDomain(ctx, sessionId, envelope);
    return;
  }

  if (envelope.domain === "feature" && envelope.action === "updated") {
    const p = parseFeatureUpdatedPayload(envelope.payload);
    if (p?.feature_id) invalidateFeatureQueries(p.feature_id, p.changed);
    return;
  }

  if (envelope.domain === "workflow") {
    // `worktree.created` / `worktree.ready` are the moments when the
    // backend has just written `worktree_path` to the DB and the
    // git-status watcher needs to be re-bound to the new path. Bump the
    // per-feature epoch so any mounted `useGitStatusSubscription` re-issues
    // its subscribe envelope (which makes the backend re-resolve the path).
    if (envelope.action === "worktree.created" || envelope.action === "worktree.ready") {
      const featureId =
        isRecord(envelope.payload) && typeof envelope.payload.feature_id === "number"
          ? envelope.payload.feature_id
          : null;
      if (featureId != null) {
        useGitStatusStore.getState().bumpWatcherEpoch(featureId);
      }
    }
    handleWorktreeEvent(ctx, sessionId, envelope.action, envelope.payload);
    return;
  }

  if (envelope.domain !== "session") return;

  handleSessionAction(ctx, sessionId, envelope);
}

// Commands domain

function handleCommandsDomain(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; ref?: string; payload: unknown },
): void {
  if (envelope.action === "list" || envelope.action === "updated") {
    const p = parseCommandsListPayload(envelope.payload);
    if (!p) return;
    const session = ctx.getSession(sessionId);
    if (
      envelope.action === "list" &&
      (!envelope.ref || envelope.ref !== session.slashCommandsRequestRef)
    ) {
      return;
    }
    const cmds: SlashCommand[] = (p.commands ?? []).map((c) => ({
      name: c.name,
      description: c.description ?? "",
      kind: c.kind ?? "command",
    }));
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        slashCommands: cmds,
        promptCommandPolicy: promptCommandPolicyFromPayload(p.prompt_command_policy),
        slashCommandsLoading: false,
        ...(envelope.action === "list" ? { slashCommandsRequestRef: null } : {}),
      }),
    );
    return;
  }
  console.warn("[ws-session] unknown commands action; dropping envelope", envelope.action);
}

type SessionActionHandler = (ctx: StoreAccessors, sessionId: string, payload: unknown) => void;

/** Intentional no-op for actions we receive but deliberately don't act on. */
const ignoreSessionAction: SessionActionHandler = () => {};

/**
 * Single dispatch table keyed by the typed {@link SESSION_ACTION} contract.
 * Replaces the three hand-mirrored string switches this file used to chain.
 * Exhaustive over `SessionActionName`, so adding a backend action to the
 * contract fails the type-check until it is handled (or explicitly ignored).
 */
type HandledSessionAction = SessionActionName | LegacySessionActionName;

const SESSION_ACTION_HANDLERS: Record<HandledSessionAction, SessionActionHandler> = {
  [SESSION_ACTION.initialized]: handleInitialized,
  // Correlated command replies are consumed by pendingWsRequests above.
  [SESSION_ACTION.acknowledged]: ignoreSessionAction,
  [SESSION_ACTION.retry_worktree_setupok]: ignoreSessionAction,
  [SESSION_ACTION.historyresult]: ignoreSessionAction,
  [SESSION_ACTION.historyadded]: ignoreSessionAction,
  [SESSION_ACTION.draftresult]: ignoreSessionAction,
  [SESSION_ACTION.draftsaved]: ignoreSessionAction,
  [SESSION_ACTION.branchneeds_confirm]: ignoreSessionAction,
  [SESSION_ACTION.runtime_session_id]: handleRuntimeSessionId,
  [SESSION_ACTION.mcp_servers]: handleMcpServers,
  [SESSION_ACTION.message]: handleMessage,
  [SESSION_ACTION.user_message]: handleCanonicalUserMessage,
  [SESSION_ACTION.permissionrequest]: handlePermissionRequest,
  [SESSION_ACTION.error]: handleError,
  [SESSION_ACTION.compacting]: handleCompacting,
  [SESSION_ACTION.access_modechanged]: handleAccessModeChanged,
  [LEGACY_SESSION_ACTION.codexPermissionModeChanged]: handleAccessModeChanged,
  [SESSION_ACTION.modechanged]: handleModeChanged,
  [SESSION_ACTION.providersetok]: handleProviderSetOk,
  [SESSION_ACTION.modelsetok]: handleModelSetOk,
  [SESSION_ACTION.effortsetok]: handleEffortSetOk,
  [SESSION_ACTION.fast_modesetok]: handleFastModeSetOk,
  [SESSION_ACTION.profilechanged]: handleProfileChanged,
  [SESSION_ACTION.runtime_overrideschanged]: handleRuntimeOverridesChanged,
  [SESSION_ACTION.compactstarted]: handleCompactStarted,
  [LEGACY_SESSION_ACTION.compactOk]: handleCompactOk,
  [SESSION_ACTION.cleared]: handleCleared,
  [SESSION_ACTION.deleted]: handleDeleted,
  [SESSION_ACTION.usage_update]: handleUsageUpdate,
  [SESSION_ACTION.stream_status]: handleStreamStatus,
  [SESSION_ACTION.persistence_status]: handlePersistenceStatus,
  [SESSION_ACTION.prompt_received]: handlePromptReceived,
  [SESSION_ACTION.lifecycle]: handleLifecyclePayload,
  [SESSION_ACTION.gateclosed]: handleGateClosed,
  [SESSION_ACTION.featurerenamed]: handleFeatureRenamed,
  [SESSION_ACTION.featureautonaming]: handleFeatureAutoNaming,
  // Broadcast from another device's rewind (the originator handled its own
  // reply via sendRequest). Mirror the conversation truncation locally.
  [SESSION_ACTION.branchrewound]: handleBranchRewoundBroadcast,
  // A fork on another device creates a new feature; that device's sidebar
  // refreshes via the `feature.created` broadcast, so this ref-less
  // `branch.forked` broadcast needs no per-session handling here.
  [SESSION_ACTION.branchforked]: ignoreSessionAction,
  [SESSION_ACTION.configsnapshot]: handleSessionConfigSnapshot,
  [SESSION_ACTION.ended]: handleTurnEndWithSubagents(handleTurnComplete),
  [LEGACY_SESSION_ACTION.turnComplete]: handleTurnEndWithSubagents(handleTurnComplete),
  [LEGACY_SESSION_ACTION.subagentUpdated]: handleSubagentUpdated,
};

function isHandledSessionAction(action: string): action is HandledSessionAction {
  return Object.hasOwn(SESSION_ACTION_HANDLERS, action);
}

function handleSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): void {
  if (!isHandledSessionAction(envelope.action)) {
    // Never drop a session envelope silently: an unknown action means the FE
    // contract has drifted from the backend emit sites (or a typo shipped).
    // Surface it so the mismatch is diagnosable instead of a feature quietly
    // going dead (error-handling.md).
    console.warn("[ws-session] unknown session action; dropping envelope", envelope.action);
    return;
  }
  SESSION_ACTION_HANDLERS[envelope.action](ctx, sessionId, envelope.payload);
}

function handleBranchRewoundBroadcast(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  if (!isRecord(payload) || typeof payload.messageId !== "number") return;
  truncateBlocksAtMessage(ctx.get, ctx.set, sessionId, payload.messageId);
}

function handleProviderSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseProviderPayload(payload);
  // An empty model is deliberate — the backend says this provider exposes no
  // usable model — and must not discard the provider change with it. Only a
  // missing field means "no update to apply".
  if (!p?.provider || p.model === undefined) return;
  const session = ctx.getSession(sessionId);
  const providerChanged = p.provider !== session.currentSelection?.providerId;
  const accessMode = p.access_mode ?? p.codex_permission_mode;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      currentSelection: { providerId: p.provider, modelId: p.model },
      ...(p.profile !== undefined || providerChanged
        ? { currentProfile: p.profile ?? undefined }
        : {}),
      ...(p.runtime_overrides !== undefined || providerChanged
        ? { runtimeOverrides: p.runtime_overrides }
        : {}),
      ...(p.thinking_effort !== undefined || providerChanged
        ? { currentThinkingEffort: p.thinking_effort ?? undefined }
        : {}),
      fastMode: p.fast_mode ?? (providerChanged ? false : session.fastMode),
      mcpServers: null,
      ...createSessionConfigState(),
      supportsPromptReceipts: p.supports_prompt_receipts ?? false,
      ...(accessMode
        ? {
            accessMode: parseAccessMode(accessMode),
          }
        : {}),
    }),
  );
}

function handleModelSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseModelPayload(payload);
  if (!p?.model || !p.provider) return;
  const session = ctx.getSession(sessionId);
  const existing = session.contextUsage;
  // The window belongs to the model, so the outgoing one is never carried over.
  // The backend seeds the incoming model's window when its adapter can answer;
  // otherwise the bar shows the window as unknown until the next `result`, which beats scaling by the
  // old model's window (1M → 200k reads 5x low, 200k → 1M reads 5x high).
  const nextContextWindow = normalizeContextWindow(p.context_window);
  const nextUsage = existing
    ? { ...existing, contextWindow: nextContextWindow }
    : { inputTokens: 0, outputTokens: 0, contextWindow: nextContextWindow, wasCompacted: false };
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      currentSelection: { providerId: p.provider, modelId: p.model },
      contextUsage: nextUsage,
      ...(session.runtimeSessionId && session.sessionConfigSupported === true
        ? createSessionConfigState()
        : {}),
    }),
  );
}

function handleFastModeSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const parsed = parseFastModePayload(payload);
  if (!parsed) return;
  ctx.set(updateSession(ctx.get(), sessionId, { fastMode: parsed.enabled }));
}

function handleProfileChanged(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseProfilePayload(payload);
  if (p?.profile) {
    const current = ctx.get().sessions[sessionId]?.currentSelection;
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        currentProfile: p.profile,
        ...(p.effective
          ? {
              currentSelection: current
                ? { providerId: current.providerId, modelId: p.effective.model ?? "" }
                : null,
              currentThinkingEffort: p.effective.thinking_effort ?? undefined,
              fastMode: p.effective.fast_mode,
            }
          : {}),
      }),
    );
  }
}

function handleCompactStarted(ctx: StoreAccessors, sessionId: string): void {
  if (!ctx.getSession(sessionId).compactRequestPending) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      compactRequestPending: false,
      pendingManualCompact: true,
    }),
  );
}

function handleCompactOk(ctx: StoreAccessors, sessionId: string): void {
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      lifecycle: transitionTurn(ctx.getSession(sessionId).lifecycle, {
        type: "turn_ended",
        reason: "completed",
      }),
      compactRequestPending: false,
      pendingManualCompact: false,
      runtimeCompacting: false,
    }),
  );
}

function handleDeleted(ctx: StoreAccessors, sessionId: string): void {
  discardStreamDeltas(sessionId);
  failPromptDelivery(sessionId, SESSION_CLOSED_BEFORE_DELIVERY);
  const del = ctx.get().sessions[sessionId];
  if (del?.conn) del.conn.close();
  const { [sessionId]: _, ...rest } = ctx.get().sessions;
  ctx.set({ sessions: rest });
}

function handleLifecyclePayload(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseLifecyclePayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  const event = p.kind === "suspend_requested" ? "suspended" : "resumed";
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      lifecycle: transitionTurn(session.lifecycle, { type: event }),
    }),
  );
}

function handleFeatureRenamed(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseFeatureRenamePayload(payload);
  if (p?.title) ctx.set(updateSession(ctx.get(), sessionId, { featureTitle: p.title }));
}

function handleFeatureAutoNaming(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseFeatureAutoNamingPayload(payload);
  if (p) ctx.set(updateSession(ctx.get(), sessionId, { isAutoNaming: p.in_progress }));
}
