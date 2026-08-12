import type { SlashCommand } from "@/lib/slash-command";
import { promptCommandPolicyFromPayload } from "@/lib/prompt-command-policy";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import { queryClient } from "@/lib/queryClient";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import {
  parseRuntimeSessionIdPayload,
  parseCommandsListPayload,
  parseFeatureAutoNamingPayload,
  parseFeatureRenamePayload,
  parseFeatureUpdatedPayload,
  parseEffortPayload,
  parseFastModePayload,
  parseLifecyclePayload,
  parseModePayload,
  parseModelPayload,
  parseProviderPayload,
  parseProfilePayload,
  parseSessionConfigSnapshotPayload,
} from "./ws-envelope-payload";
import { normalizeContextWindow } from "@/types/agent";
import { truncateBlocksAtMessage } from "./ws-session-branch";
import { handleWorktreeEvent } from "./ws-worktree-handler";
import { useGitStatusStore } from "./useGitStatusStore";
import { isRecord } from "./ws-message-processing";
import { parseAccessMode } from "@/types/access-mode";
import { createSessionConfigState, updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { findProviderMode } from "@/lib/provider-modes";
import { OPENCODE_AGENT_MODE_PREFIX, parsePermissionMode } from "@/types/permission-mode";
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
import {
  handleStreamStatus,
  handleTurnComplete,
  handleUsageUpdate,
} from "./ws-envelope-turn-handlers";
import { SESSION_ACTION, type SessionActionName } from "./ws-session-action-names";
import { discardStreamDeltas } from "./ws-delta-coalescer";

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
      return;
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
const SESSION_ACTION_HANDLERS: Record<SessionActionName, SessionActionHandler> = {
  [SESSION_ACTION.initialized]: handleInitialized,
  [SESSION_ACTION.runtimeSessionId]: handleRuntimeSessionId,
  [SESSION_ACTION.mcpServers]: handleMcpServers,
  [SESSION_ACTION.message]: handleMessage,
  [SESSION_ACTION.userMessage]: handleCanonicalUserMessage,
  [SESSION_ACTION.permissionRequest]: handlePermissionRequest,
  [SESSION_ACTION.error]: handleError,
  [SESSION_ACTION.compacting]: handleCompacting,
  [SESSION_ACTION.accessModeChanged]: handleAccessModeChanged,
  [SESSION_ACTION.legacyCodexPermissionModeChanged]: handleAccessModeChanged,
  [SESSION_ACTION.modeChanged]: handleModeChanged,
  [SESSION_ACTION.providerSetOk]: handleProviderSetOk,
  [SESSION_ACTION.modelSetOk]: handleModelSetOk,
  [SESSION_ACTION.effortSetOk]: handleEffortSetOk,
  [SESSION_ACTION.fastModeSetOk]: handleFastModeSetOk,
  [SESSION_ACTION.profileChanged]: handleProfileChanged,
  [SESSION_ACTION.compactStarted]: handleCompactStarted,
  [SESSION_ACTION.compactOk]: handleCompactOk,
  [SESSION_ACTION.cleared]: handleCleared,
  [SESSION_ACTION.deleted]: handleDeleted,
  [SESSION_ACTION.usageUpdate]: handleUsageUpdate,
  [SESSION_ACTION.streamStatus]: handleStreamStatus,
  [SESSION_ACTION.promptReceived]: handlePromptReceived,
  [SESSION_ACTION.lifecycle]: handleLifecyclePayload,
  [SESSION_ACTION.gateClosed]: handleGateClosed,
  [SESSION_ACTION.featureRenamed]: handleFeatureRenamed,
  [SESSION_ACTION.featureAutonaming]: handleFeatureAutoNaming,
  // Broadcast from another device's rewind (the originator handled its own
  // reply via sendRequest). Mirror the conversation truncation locally.
  [SESSION_ACTION.branchRewound]: handleBranchRewoundBroadcast,
  // A fork on another device creates a new feature; that device's sidebar
  // refreshes via the `feature.created` broadcast, so this ref-less
  // `branch.forked` broadcast needs no per-session handling here.
  [SESSION_ACTION.branchForked]: ignoreSessionAction,
  [SESSION_ACTION.configSnapshot]: handleSessionConfigSnapshot,
  [SESSION_ACTION.ended]: handleTurnComplete,
  [SESSION_ACTION.turnComplete]: handleTurnComplete,
};

function handleSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): void {
  // Typed `| undefined` (rather than leaning on the cast) so the guard below
  // reads as the load-bearing runtime check it is: `envelope.action` is an
  // arbitrary wire string, not necessarily a known `SessionActionName`.
  const handler: SessionActionHandler | undefined =
    SESSION_ACTION_HANDLERS[envelope.action as SessionActionName];
  if (!handler) {
    // Never drop a session envelope silently: an unknown action means the FE
    // contract has drifted from the backend emit sites (or a typo shipped).
    // Surface it so the mismatch is diagnosable instead of a feature quietly
    // going dead (error-handling.md).
    console.warn("[ws-session] unknown session action; dropping envelope", envelope.action);
    return;
  }
  handler(ctx, sessionId, envelope.payload);
}

function handleBranchRewoundBroadcast(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  if (!isRecord(payload) || typeof payload.messageId !== "number") return;
  truncateBlocksAtMessage(ctx.get, ctx.set, sessionId, payload.messageId);
}

function handleRuntimeSessionId(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseRuntimeSessionIdPayload(payload);
  const sessionIdValue = p?.runtime_session_id;
  if (sessionIdValue && sessionIdValue !== ctx.getSession(sessionId).runtimeSessionId) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        runtimeSessionId: sessionIdValue,
        ...createSessionConfigState(),
      }),
    );
  }
}

function handleSessionConfigSnapshot(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const snapshot = parseSessionConfigSnapshotPayload(payload);
  if (!snapshot) {
    console.warn("[ws-session] invalid config.snapshot broadcast", payload);
    return;
  }
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      sessionConfig: snapshot.config,
      sessionConfigLoading: false,
      sessionConfigSupported: true,
      sessionConfigError: null,
      pendingSessionConfigId: null,
    }),
  );
}

function handleAccessModeChanged(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseModePayload(payload);
  if (p?.mode) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        accessMode: parseAccessMode(p.mode),
      }),
    );
  }
}

function handleModeChanged(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseModePayload(payload);
  const session = p?.mode ? ctx.getSession(sessionId) : null;
  const parsedMode = p?.mode ? parsePermissionMode(p.mode) : null;
  if (!parsedMode || !session) return;
  const providerId = session.currentProviderId || session.runtimeProvider;
  const acceptsMode =
    !!findProviderMode(providerId, parsedMode) || parsedMode.startsWith(OPENCODE_AGENT_MODE_PREFIX);
  if (acceptsMode) {
    ctx.set(updateSession(ctx.get(), sessionId, { permissionMode: parsedMode }));
  }
}

function handleProviderSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseProviderPayload(payload);
  if (!p?.provider) return;
  const session = ctx.getSession(sessionId);
  const providerChanged = p.provider !== session.currentProviderId;
  const accessMode = p.access_mode ?? p.codex_permission_mode;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      currentProviderId: p.provider,
      runtimeProvider: p.provider,
      ...(providerChanged ? { currentModelId: "" } : {}),
      ...(providerChanged ? { fastMode: false } : {}),
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
  if (!p) return;
  const session = ctx.getSession(sessionId);
  // The window belongs to the model, so the outgoing one is never carried over.
  // The backend seeds the incoming model's window when its adapter can answer;
  // otherwise the bar hides until the next `result`, which beats scaling by the
  // old model's window (1M → 200k reads 5x low, 200k → 1M reads 5x high).
  const nextContextWindow = normalizeContextWindow(p.context_window);
  const nextUsage = session.contextUsage
    ? { ...session.contextUsage, contextWindow: nextContextWindow }
    : { inputTokens: 0, outputTokens: 0, contextWindow: nextContextWindow, wasCompacted: false };
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      currentProviderId: p.provider,
      currentModelId: p.model,
      runtimeProvider: p.provider,
      contextUsage: nextUsage,
    }),
  );
}

function handleEffortSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseEffortPayload(payload);
  const previous = ctx.get().sessions[sessionId]?.currentThinkingEffort;
  ctx.set(updateSession(ctx.get(), sessionId, { currentThinkingEffort: p?.thinking_effort }));
  if (p?.thinking_effort !== previous) {
    void queryClient.invalidateQueries({ queryKey: getWorkspaceSettingsQueryKey() });
  }
}

function handleFastModeSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const parsed = parseFastModePayload(payload);
  if (!parsed) return;
  ctx.set(updateSession(ctx.get(), sessionId, { fastMode: parsed.enabled }));
}

function handleProfileChanged(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseProfilePayload(payload);
  if (p?.profile) {
    if (ctx.get().sessions[sessionId]?.currentProfile === p.profile) return;
    ctx.set(updateSession(ctx.get(), sessionId, { currentProfile: p.profile }));
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
