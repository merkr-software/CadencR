import { toast } from "sonner";
import type { AgentQuestion } from "@/components/AgentQuestionDrawer";
import { parseAskUserQuestions } from "@/components/AgentQuestionDrawer";
import type { SlashCommand } from "@/hooks/useSlashCommand";
import { invalidateFeatureQueries } from "@/lib/featureUpdated";
import { queryClient } from "@/lib/queryClient";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import {
  parseRuntimeSessionIdPayload,
  parseClearedPayload,
  parseCommandsListPayload,
  parseEndedPayload,
  parseErrorPayload,
  parseFeatureAutoNamingPayload,
  parseFeatureRenamePayload,
  parseFeatureUpdatedPayload,
  parseGateClosedPayload,
  parseEffortPayload,
  parseInitializedPayload,
  parseLifecyclePayload,
  parseMessageBlocksPayload,
  parseModePayload,
  parseModelPayload,
  parsePermissionPayload,
  parsePromptReceivedPayload,
  parseProviderPayload,
  parseStreamStatusPayload,
  parseUsagePayload,
} from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import { handleWorktreeEvent } from "./ws-worktree-handler";
import { useGitStatusStore } from "./useGitStatusStore";
import {
  type BlockMutation,
  blocksPatchWithDerived,
  createStreamingState,
  isRecord,
  processSdkMessage,
  applyMutations,
  buildMessagePatch,
} from "./ws-message-processing";
import { normalizeContextWindow } from "@/types/agent";
import type { SessionEntry, WsSessionStore } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn, type TurnTerminalReason } from "./ws-turn-lifecycle";
import { findProviderMode, nextProviderMode } from "@/lib/provider-modes";
import { getEnabledOptInModesFromCache } from "@/hooks/useEnabledOptInModes";
import {
  OPENCODE_AGENT_MODE_PREFIX,
  parsePermissionMode,
  type PermissionMode,
} from "@/types/permission-mode";
import { upsertPendingPermission } from "@/lib/pending-permission-queue";
import { makeErrorBlock } from "./ws-session-store-helpers";
import {
  deferTailPromptTurnBoundary,
  markPromptReceived,
  movePendingPromptBlocksToTail,
  removePendingPromptBlocks,
} from "./ws-pending-prompts";

// Types for the store accessors we need

export interface StoreAccessors {
  get: () => WsSessionStore;
  set: (partial: Partial<WsSessionStore>) => void;
  getSession: (sessionId: string) => SessionEntry;
}

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
  switch (envelope.action) {
    case "initialized":
      handleInitialized(ctx, sessionId, envelope.payload);
      break;
    case "runtime_session_id": {
      const p = parseRuntimeSessionIdPayload(envelope.payload);
      const sessionIdValue = p?.runtime_session_id;
      if (sessionIdValue && sessionIdValue !== ctx.getSession(sessionId).runtimeSessionId) {
        ctx.set(
          updateSession(ctx.get(), sessionId, {
            runtimeSessionId: sessionIdValue,
          }),
        );
      }
      break;
    }
    case "message":
      handleMessage(ctx, sessionId, envelope.payload);
      break;
    case "permission.request":
      handlePermissionRequest(ctx, sessionId, envelope.payload);
      break;
    case "mode.changed": {
      const p = parseModePayload(envelope.payload);
      // Accept any mode the active provider's catalog defines. Unknown values
      // are dropped silently — the backend rejects them via MODE_NOT_SUPPORTED
      // before we ever see this event, so reaching this branch with an
      // unrecognized mode would mean the FE catalog is stale.
      const session = p?.mode ? ctx.getSession(sessionId) : null;
      const parsedMode = p?.mode ? parsePermissionMode(p.mode) : null;
      if (parsedMode && session) {
        const providerId = session.currentProviderId || session.runtimeProvider;
        if (
          findProviderMode(providerId, parsedMode) ||
          parsedMode.startsWith(OPENCODE_AGENT_MODE_PREFIX)
        ) {
          ctx.set(
            updateSession(ctx.get(), sessionId, {
              permissionMode: parsedMode,
            }),
          );
        }
      }
      break;
    }
    case "provider.set.ok": {
      const p = parseProviderPayload(envelope.payload);
      if (p?.provider) {
        // Provider switch only updates provider state; the backend follows up
        // with a `mode.changed` envelope carrying the new provider's default
        // permission mode. We let that envelope drive the chip state via the
        // shared path above instead of writing it optimistically here (would
        // create dual sources of truth — see no-optimistic-updates.md).
        ctx.set(
          updateSession(ctx.get(), sessionId, {
            currentProviderId: p.provider,
            runtimeProvider: p.provider,
            supportsPromptReceipts: p.supports_prompt_receipts ?? false,
          }),
        );
      }
      break;
    }
    case "model.set.ok": {
      const p = parseModelPayload(envelope.payload);
      if (p?.model) {
        // A model switch does not alter conversation history, so tokens are
        // preserved. `context_window` is updated only when the backend
        // seeded one authoritatively — otherwise we mark the window as
        // unknown (null) and wait for the next `usage_update`/`result`.
        const existing = ctx.getSession(sessionId).contextUsage;
        const nextContextWindow = p.context_window ?? existing?.contextWindow ?? null;
        const nextUsage = existing
          ? { ...existing, contextWindow: nextContextWindow }
          : {
              inputTokens: 0,
              outputTokens: 0,
              contextWindow: nextContextWindow,
              wasCompacted: false,
            };
        ctx.set(
          updateSession(ctx.get(), sessionId, {
            currentModelId: p.model,
            contextUsage: nextUsage,
          }),
        );
      }
      break;
    }
    case "effort.set.ok": {
      const p = parseEffortPayload(envelope.payload);
      const previous = ctx.get().sessions[sessionId]?.currentThinkingEffort;
      ctx.set(updateSession(ctx.get(), sessionId, { currentThinkingEffort: p?.thinking_effort }));
      // The backend writes the per-model workspace default
      // (`thinking_effort_model_<provider>_<model>`) only when the effort
      // actually changed, so we mirror that condition to avoid a redundant
      // workspace-settings refetch on no-op confirmations.
      if (p?.thinking_effort !== previous) {
        void queryClient.invalidateQueries({ queryKey: getWorkspaceSettingsQueryKey() });
      }
      break;
    }
    case "error":
      handleError(ctx, sessionId, envelope.payload);
      break;
    case "compact.ok":
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          lifecycle: transitionTurn(ctx.getSession(sessionId).lifecycle, {
            type: "turn_ended",
            reason: "completed",
          }),
          pendingManualCompact: false,
        }),
      );
      break;
    case "cleared":
      handleCleared(ctx, sessionId, envelope.payload);
      break;
    case "deleted": {
      const del = ctx.get().sessions[sessionId];
      if (del?.conn) del.conn.close();
      const { [sessionId]: _, ...rest } = ctx.get().sessions;
      ctx.set({ sessions: rest });
      break;
    }
    case "usage_update":
      handleUsageUpdate(ctx, sessionId, envelope.payload);
      break;
    case "stream_status":
      handleStreamStatus(ctx, sessionId, envelope.payload);
      break;
    case "prompt_received":
      handlePromptReceived(ctx, sessionId, envelope.payload);
      break;
    case "lifecycle": {
      // OS suspend / resume — backend-confirmed transitions. Per
      // `no-optimistic-updates.md`, the FE flips lifecycle only here,
      // never on the raw Electron power event.
      const p = parseLifecyclePayload(envelope.payload);
      if (!p) break;
      const session = ctx.getSession(sessionId);
      const event = p.kind === "suspend_requested" ? "suspended" : "resumed";
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          lifecycle: transitionTurn(session.lifecycle, { type: event }),
        }),
      );
      break;
    }
    case "gate.closed":
      handleGateClosed(ctx, sessionId, envelope.payload);
      break;
    case "feature.renamed": {
      const p = parseFeatureRenamePayload(envelope.payload);
      if (p?.title) ctx.set(updateSession(ctx.get(), sessionId, { featureTitle: p.title }));
      break;
    }
    case "feature.autonaming": {
      const p = parseFeatureAutoNamingPayload(envelope.payload);
      if (p) ctx.set(updateSession(ctx.get(), sessionId, { isAutoNaming: p.in_progress }));
      break;
    }
    case "ended":
    case "turn_complete":
      handleTurnComplete(ctx, sessionId, envelope.payload);
      break;
  }
}

function handleGateClosed(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseGateClosedPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  const gatePatch = buildClearedGatePatch(session);
  if (!gatePatch) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...gatePatch,
      lifecycle: transitionTurn(session.lifecycle, {
        type: "turn_ended",
        reason: p.reason === "sleep" ? "streamClosed" : "denied",
      }),
    }),
  );
}

function handleInitialized(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseInitializedPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  const updates: Partial<SessionEntry> = {
    serverSessionId: p.session_id ?? "",
    lifecycle: transitionTurn(session.lifecycle, { type: "initialized" }),
    supportsPromptReceipts: p.supports_prompt_receipts ?? false,
  };
  if (p.provider) {
    updates.currentProviderId = p.provider;
    updates.runtimeProvider = p.provider;
  } else {
    updates.runtimeProvider = ctx.getSession(sessionId).currentProviderId;
  }
  if (p.model) updates.currentModelId = p.model;
  updates.currentThinkingEffort = p.thinking_effort;
  if (p.input_tokens != null || p.output_tokens != null) {
    const contextWindow =
      normalizeContextWindow(p.context_window) ?? session.contextUsage?.contextWindow ?? null;
    updates.contextUsage = {
      inputTokens: p.input_tokens ?? 0,
      outputTokens: p.output_tokens ?? 0,
      contextWindow,
      wasCompacted: false,
    };
  }
  ctx.set(updateSession(ctx.get(), sessionId, updates));
}

function handleMessage(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseMessageBlocksPayload(payload);
  if (!p) return;
  const state = ctx.getSession(sessionId).streamingState;

  const allMutations: BlockMutation[] = [];
  let enterPlanModeRequested = false;
  let compactBoundaryObserved = false;
  let manualCompactBoundaryObserved = false;
  for (const rawBlock of p.blocks) {
    if (!isRecord(rawBlock)) continue;
    const result = processSdkMessage(rawBlock, state);
    allMutations.push(...result.mutations);
    enterPlanModeRequested ||= result.signals.enterPlanModeRequested;
    compactBoundaryObserved ||= result.signals.compactBoundaryObserved;
    // Older persisted/runtime boundaries may not include metadata. Treat that
    // shape as manual so an in-flight explicit `/compact` can complete.
    manualCompactBoundaryObserved ||=
      result.signals.compactBoundaryObserved && result.signals.compactBoundaryTrigger !== "auto";
  }

  if (allMutations.length === 0 && !compactBoundaryObserved) return;

  const currentSession = ctx.getSession(sessionId);
  const patch: Partial<SessionEntry> = {};
  if (allMutations.length > 0) {
    const appliedBlocks = applyMutations(currentSession.blocks, allMutations, state);
    const newBlocks = movePendingPromptBlocksToTail(appliedBlocks);
    Object.assign(patch, buildMessagePatch(newBlocks, allMutations, { enterPlanModeRequested }));
    // applyMutations maintains the derived state on `streamState` in O(1) per
    // mutation; snapshot fresh refs so React detects the change.
    if (newBlocks === appliedBlocks) {
      patch.rootBlocks = state.rootBlocks.slice();
      patch.toolResultMap = new Map(state.toolResultMap);
    } else {
      Object.assign(patch, blocksPatchWithDerived(state, newBlocks));
    }
  }

  if (compactBoundaryObserved) {
    const existing = currentSession.contextUsage;
    patch.contextUsage = existing
      ? { ...existing, wasCompacted: true }
      : {
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: null,
          wasCompacted: true,
        };
  }

  patch.lifecycle =
    manualCompactBoundaryObserved && currentSession.pendingManualCompact
      ? transitionTurn(currentSession.lifecycle, { type: "turn_ended", reason: "completed" })
      : transitionTurn(currentSession.lifecycle, { type: "stream_activity" });
  if (manualCompactBoundaryObserved && currentSession.pendingManualCompact) {
    patch.pendingManualCompact = false;
  }

  ctx.set(updateSession(ctx.get(), sessionId, patch));
}

function handlePermissionRequest(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parsePermissionPayload(payload);
  if (!p?.request_id || !p.tool_name) return;
  const session = ctx.get().sessions[sessionId];

  if (p.tool_name === "ExitPlanMode") {
    const current = ctx.get();
    const enrichedArgs = JSON.stringify(p.tool_input ?? {});
    const updatedBlocks = session?.blocks.map((b) =>
      b.type === "tool_call" && b.toolName === "ExitPlanMode" && b.toolUseId === p.request_id
        ? { ...b, toolArgs: enrichedArgs }
        : b,
    );
    ctx.set(
      updateSession(current, sessionId, {
        ...(updatedBlocks && session
          ? blocksPatchWithDerived(session.streamingState, updatedBlocks)
          : {}),
        pendingRequestId: p.request_id,
        pendingPlanApproval: p.tool_input ?? {},
        lifecycle: transitionTurn(session?.lifecycle ?? { phase: "idle" }, {
          type: "plan_approval_requested",
        }),
      }),
    );
  } else if (p.tool_name === "AskUserQuestion") {
    const toolInput = p.tool_input ?? {};
    const questions: AgentQuestion[] = parseAskUserQuestions(toolInput);
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        pendingRequestId: p.request_id,
        pendingQuestions: questions,
        pendingQuestionToolInput: toolInput,
        lifecycle: transitionTurn(session?.lifecycle ?? { phase: "idle" }, {
          type: "question_requested",
        }),
      }),
    );
  } else {
    const pendingPermission = {
      toolName: p.tool_name,
      input: p.tool_input ?? {},
      description: p.description ?? "",
      pattern: p.pattern ?? "",
      preview: p.preview,
      options: p.options,
      requestId: p.request_id,
    };
    const permissionPatch = upsertPendingPermission(
      session ?? { pendingPermission: null, pendingPermissionQueue: [] },
      pendingPermission,
    );
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        ...permissionPatch,
        pendingRequestId: permissionPatch.pendingPermission?.requestId ?? "",
        lifecycle: transitionTurn(session?.lifecycle ?? { phase: "idle" }, {
          type: "permission_requested",
        }),
      }),
    );
  }
}

/**
 * Error codes whose user mistake originates outside the agent stream (e.g. a
 * meta-bar action). Surfacing these as inline error blocks in the chat is
 * confusing — the user wasn't talking to the agent. Route them to a toast
 * instead, and don't transition the turn lifecycle since no turn was active.
 */
const TOAST_ERROR_CODES = new Set(["MODE_NOT_SUPPORTED"]);

function handleError(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseErrorPayload(payload);

  if (p?.code && TOAST_ERROR_CODES.has(p.code) && p.message) {
    toast.error(p.message);
    return;
  }

  // CLI refused a specific permission mode (e.g. Claude Code `auto` on a
  // non-auto-capable model). The payload carries the rejected wire mode;
  // skip past it in the Shift+Tab cycle so the chip isn't stuck.
  if (p?.code === "MODE_REJECTED_BY_CLI" && p.mode) {
    handleModeRejectedByCli(ctx, sessionId, p.mode as PermissionMode, p.message);
    return;
  }

  const session = ctx.getSession(sessionId);
  const gatePatch = isGateClosingErrorCode(p?.code) ? buildClearedGatePatch(session) : null;
  // A manual compaction holds the prompt turn — a follow-up `prompt.send` while
  // compacting fails the steering RPC and the backend emits `session.error`,
  // but the underlying compaction is still running. Surface the error inline
  // (so the user sees what happened) without flipping the turn to `error` or
  // clearing the compaction flag — both of those would lie about the agent
  // having stopped.
  const lifecyclePatch: Partial<SessionEntry> = session.pendingManualCompact
    ? {}
    : {
        lifecycle: transitionTurn(session.lifecycle, {
          type: "turn_errored" as const,
          ...(p?.message ? { message: p.message } : {}),
        }),
        pendingManualCompact: false,
      };
  if (!p?.message) {
    const patch = { ...lifecyclePatch, ...gatePatch };
    if (Object.keys(patch).length === 0) return;
    ctx.set(updateSession(ctx.get(), sessionId, patch));
    return;
  }
  const errorBlock = makeErrorBlock(session, p.message, { code: p.code });
  const blocks = removePendingPromptBlocks([...session.blocks, errorBlock]);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...lifecyclePatch,
      ...blocksPatchWithDerived(session.streamingState, blocks),
      ...gatePatch,
    }),
  );
}

function handleModeRejectedByCli(
  ctx: StoreAccessors,
  sessionId: string,
  rejectedMode: PermissionMode,
  rejectedMessage?: string,
): void {
  if (rejectedMode !== "auto") {
    toast.error(rejectedMessage ?? `${rejectedMode} mode was rejected by the provider.`);
    return;
  }

  const session = ctx.get().sessions[sessionId];
  if (!session) return;
  const providerId = session.currentProviderId || session.runtimeProvider;
  const optInModes = getEnabledOptInModesFromCache(providerId ?? "");
  const next = nextProviderMode(providerId, rejectedMode, optInModes);
  if (next === rejectedMode) return;
  ctx.get().setPermissionMode(sessionId, next);
}

function handlePromptReceived(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parsePromptReceivedPayload(payload);
  if (!p?.client_message_id) return;
  const session = ctx.getSession(sessionId);
  const blocks = markPromptReceived(session.blocks, p.client_message_id);
  if (blocks === session.blocks) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, blocksPatchWithDerived(session.streamingState, blocks)),
  );
}

function handleCleared(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const session = ctx.get().sessions[sessionId];
  const existingBlocks = session?.blocks ?? [];
  const previousSessionId = parseClearedPayload(payload)?.previous_session_id ?? "";
  const clearedBlocks = [
    ...existingBlocks,
    { id: `clear-${Date.now()}`, type: "clear_divider" as const, content: previousSessionId },
  ];
  // Reset streamingState (clear divider drops all in-flight streams) and
  // re-prime the derived rootBlocks/toolResultMap from the new blocks list.
  const freshState = createStreamingState();
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(freshState, clearedBlocks),
      lifecycle: transitionTurn(session?.lifecycle ?? { phase: "idle" }, { type: "turn_cleared" }),
      streamingState: freshState,
      historyPrependDisplayOffset: 0,
      pendingPermission: null,
      pendingPermissionQueue: [],
      pendingRequestId: "",
      pendingQuestions: [],
      pendingPlanApproval: null,
      hasFileChanges: false,
      runtimeSessionId: "",
    }),
  );
}

/**
 * `session.stream_status` envelope handler. The backend emits this when
 * the underlying transport for an agent stream goes degraded or recovers
 * (today only OpenCode emits transitions away from `"ok"`). The shape is
 * provider-neutral. PR-A wires the store flag; PR-C will render an
 * inline "Reconnecting…" banner under the loader.
 *
 * This is the user-visible counterpart to plan finding #1: the smoking-
 * gun fix in the SDK now drops subscriber senders on reconnect, the
 * service adapter forwards lifecycle events as `RuntimeStreamStatus`,
 * and we land that here so the UI never silently freezes.
 */
function handleStreamStatus(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseStreamStatusPayload(payload);
  if (!p) {
    // Surface malformed envelopes — see error-handling.md. Keeping this
    // a console warning (not a toast) since users can't act on it; the
    // backend is misbehaving.
    console.warn("[ws-session] dropped malformed stream_status envelope", { payload });
    return;
  }
  const next: SessionEntry["streamHealth"] =
    p.state === "degraded"
      ? { state: "degraded", reason: p.reason, since: Date.now() }
      : { state: "ok", since: Date.now() };
  ctx.set(updateSession(ctx.get(), sessionId, { streamHealth: next }));
}

function handleUsageUpdate(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const u = parseUsagePayload(payload);
  if (!u) return;
  const session = ctx.getSession(sessionId);
  const contextWindow = u.context_window ?? session.contextUsage?.contextWindow ?? null;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      contextUsage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        contextWindow,
        wasCompacted: session.contextUsage?.wasCompacted ?? false,
      },
    }),
  );
}

function handleTurnComplete(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const session = ctx.getSession(sessionId);
  if (session.pendingPlanApproval != null) {
    return;
  }
  const state = session.streamingState;
  for (const stream of state.streams.values()) {
    if (!stream.parentToolUseId) {
      continue;
    }
    const parent = state.toolUseIdToBlock.get(stream.parentToolUseId);
    if (parent?.childBlocks) parent.taskComplete = true;
    stream.parentToolUseId = null;
  }

  const deferredPromptBoundary = deferTailPromptTurnBoundary(session.blocks);
  if (deferredPromptBoundary.shouldDefer) {
    if (deferredPromptBoundary.blocks !== session.blocks) {
      ctx.set(
        updateSession(
          ctx.get(),
          sessionId,
          blocksPatchWithDerived(state, deferredPromptBoundary.blocks),
        ),
      );
    }
    return;
  }

  const blocks = removePendingPromptBlocks(session.blocks);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...(blocks === session.blocks ? {} : blocksPatchWithDerived(state, blocks)),
      lifecycle: transitionTurn(session.lifecycle, {
        type: "turn_ended",
        reason: mapTerminalReason(parseEndedPayload(payload)?.reason),
      }),
    }),
  );
}

function mapTerminalReason(reason: string | undefined): TurnTerminalReason {
  switch (reason) {
    case "provider_complete":
    case "turn_complete":
      return "completed";
    case "stream_closed":
      return "streamClosed";
    case "turn_cleared":
      return "cleared";
    case "permission_denied":
      return "denied";
    default:
      return "completed";
  }
}
