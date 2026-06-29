import type { SlashCommand } from "@/hooks/useSlashCommand";
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
  parseLifecyclePayload,
  parseModePayload,
  parseModelPayload,
  parseProviderPayload,
  parseProfilePayload,
} from "./ws-envelope-payload";
import { truncateBlocksAtMessage } from "./ws-session-branch";
import { handleWorktreeEvent } from "./ws-worktree-handler";
import { useGitStatusStore } from "./useGitStatusStore";
import { isRecord } from "./ws-message-processing";
import { parseCodexPermissionMode } from "@/types/codex-permission-mode";
import { updateSession } from "./ws-session-types";
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
  handlePromptPersisted,
  handlePromptReceived,
  handleUserMessageMirror,
} from "./ws-envelope-session-handlers";
import { handleError } from "./ws-envelope-error-handler";
import {
  handleStreamStatus,
  handleTurnComplete,
  handleUsageUpdate,
} from "./ws-envelope-turn-handlers";

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
  if (envelope.action === "list") {
    const p = parseCommandsListPayload(envelope.payload);
    if (!p) return;
    const session = ctx.getSession(sessionId);
    if (!envelope.ref || envelope.ref !== session.slashCommandsRequestRef) {
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
        slashCommandsLoading: false,
      }),
    );
  }
}

function handleSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): void {
  if (handleBaseSessionAction(ctx, sessionId, envelope)) return;
  if (handleConfigSessionAction(ctx, sessionId, envelope)) return;
  handleLifecycleSessionAction(ctx, sessionId, envelope);
}

function handleBaseSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): boolean {
  switch (envelope.action) {
    case "initialized":
      handleInitialized(ctx, sessionId, envelope.payload);
      return true;
    case "runtime_session_id":
      handleRuntimeSessionId(ctx, sessionId, envelope.payload);
      return true;
    case "mcp_servers":
      handleMcpServers(ctx, sessionId, envelope.payload);
      return true;
    case "message":
      handleMessage(ctx, sessionId, envelope.payload);
      return true;
    case "user_message":
      handleUserMessageMirror(ctx, sessionId, envelope.payload);
      return true;
    case "permission.request":
      handlePermissionRequest(ctx, sessionId, envelope.payload);
      return true;
    case "error":
      handleError(ctx, sessionId, envelope.payload);
      return true;
    case "compacting":
      handleCompacting(ctx, sessionId, envelope.payload);
      return true;
    default:
      return false;
  }
}

function handleConfigSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): boolean {
  switch (envelope.action) {
    case "codex_permission_mode.changed":
      handleCodexPermissionModeChanged(ctx, sessionId, envelope.payload);
      return true;
    case "mode.changed":
      handleModeChanged(ctx, sessionId, envelope.payload);
      return true;
    case "provider.set.ok":
      handleProviderSetOk(ctx, sessionId, envelope.payload);
      return true;
    case "model.set.ok":
      handleModelSetOk(ctx, sessionId, envelope.payload);
      return true;
    case "effort.set.ok":
      handleEffortSetOk(ctx, sessionId, envelope.payload);
      return true;
    case "profile.changed":
      handleProfileChanged(ctx, sessionId, envelope.payload);
      return true;
    default:
      return false;
  }
}

function handleLifecycleSessionAction(
  ctx: StoreAccessors,
  sessionId: string,
  envelope: { action: string; payload: unknown },
): void {
  switch (envelope.action) {
    case "compact.started":
      handleCompactStarted(ctx, sessionId);
      break;
    case "compact.ok":
      handleCompactOk(ctx, sessionId);
      break;
    case "cleared":
      handleCleared(ctx, sessionId, envelope.payload);
      break;
    case "deleted":
      handleDeleted(ctx, sessionId);
      break;
    case "usage_update":
      handleUsageUpdate(ctx, sessionId, envelope.payload);
      break;
    case "stream_status":
      handleStreamStatus(ctx, sessionId, envelope.payload);
      break;
    case "prompt_received":
      handlePromptReceived(ctx, sessionId, envelope.payload);
      break;
    case "prompt_persisted":
      handlePromptPersisted(ctx, sessionId, envelope.payload);
      break;
    case "lifecycle":
      handleLifecyclePayload(ctx, sessionId, envelope.payload);
      break;
    case "gate.closed":
      handleGateClosed(ctx, sessionId, envelope.payload);
      break;
    case "feature.renamed":
      handleFeatureRenamed(ctx, sessionId, envelope.payload);
      break;
    case "feature.autonaming":
      handleFeatureAutoNaming(ctx, sessionId, envelope.payload);
      break;
    case "branch.rewound":
      // Broadcast from another device's rewind (the originator handled its own
      // reply via sendRequest). Mirror the conversation truncation locally.
      handleBranchRewoundBroadcast(ctx, sessionId, envelope.payload);
      break;
    // A fork on another device creates a new feature; that device's sidebar
    // refreshes via the `feature.created` broadcast, so the ref-less
    // `branch.forked` broadcast needs no per-session handling here.
    case "ended":
    case "turn_complete":
      handleTurnComplete(ctx, sessionId, envelope.payload);
      break;
  }
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
    ctx.set(updateSession(ctx.get(), sessionId, { runtimeSessionId: sessionIdValue }));
  }
}

function handleCodexPermissionModeChanged(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parseModePayload(payload);
  if (p?.mode) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        codexPermissionMode: parseCodexPermissionMode(p.mode),
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
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      currentProviderId: p.provider,
      runtimeProvider: p.provider,
      mcpServers: null,
      supportsPromptReceipts: p.supports_prompt_receipts ?? false,
      ...(p.codex_permission_mode
        ? { codexPermissionMode: parseCodexPermissionMode(p.codex_permission_mode) }
        : {}),
    }),
  );
}

function handleModelSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseModelPayload(payload);
  if (!p?.model) return;
  const existing = ctx.getSession(sessionId).contextUsage;
  const nextContextWindow = p.context_window ?? existing?.contextWindow ?? null;
  const nextUsage = existing
    ? { ...existing, contextWindow: nextContextWindow }
    : { inputTokens: 0, outputTokens: 0, contextWindow: nextContextWindow, wasCompacted: false };
  ctx.set(
    updateSession(ctx.get(), sessionId, { currentModelId: p.model, contextUsage: nextUsage }),
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
