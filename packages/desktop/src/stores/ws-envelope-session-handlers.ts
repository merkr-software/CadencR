import type { AgentQuestion } from "@/components/AgentQuestionDrawer";
import { parseAskUserQuestions } from "@/components/AgentQuestionDrawer";
import {
  parseClearedPayload,
  parseCompactingPayload,
  parseGateClosedPayload,
  parseInitializedPayload,
  parseMcpServersPayload,
  parseMessageBlocksPayload,
  parsePermissionPayload,
  parsePromptReceivedPayload,
  parseUserMessageMirrorPayload,
} from "./ws-envelope-payload";
import { appendLocalUserMessage } from "./ws-session-store-helpers";
import { buildClearedGatePatch } from "./ws-gate-state";
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
import { parseCodexPermissionMode } from "@/types/codex-permission-mode";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { upsertPendingPermission } from "@/lib/pending-permission-queue";
import { markPromptReceived, movePendingPromptBlocksToTail } from "./ws-pending-prompts";
import type { StoreAccessors } from "./ws-envelope-types";
import { queryClient } from "@/lib/queryClient";
import { getGetScheduledMessageQueryKey } from "@/api/generated";

export function handleCompacting(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseCompactingPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  if (session.runtimeCompacting === p.active) return;
  ctx.set(updateSession(ctx.get(), sessionId, { runtimeCompacting: p.active }));
}

export function handleGateClosed(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
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

export function handleInitialized(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseInitializedPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  const updates: Partial<SessionEntry> = {
    serverSessionId: p.session_id ?? "",
    lifecycle: transitionTurn(session.lifecycle, { type: "initialized" }),
    mcpServers: null,
    supportsPromptReceipts: p.supports_prompt_receipts ?? false,
  };
  if (p.sessionDbId != null) updates.sessionDbId = p.sessionDbId;
  if (p.provider) {
    updates.currentProviderId = p.provider;
    updates.runtimeProvider = p.provider;
  } else {
    updates.runtimeProvider = ctx.getSession(sessionId).currentProviderId;
  }
  if (p.model) updates.currentModelId = p.model;
  if (p.codex_permission_mode) {
    updates.codexPermissionMode = parseCodexPermissionMode(p.codex_permission_mode);
  }
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

export function handleMcpServers(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseMcpServersPayload(payload);
  if (!p) return;
  const current = ctx.getSession(sessionId).mcpServers;
  if (mcpServersEqual(current, p.mcpServers)) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      mcpServers: p.mcpServers,
    }),
  );
}

function mcpServersEqual(
  current: SessionEntry["mcpServers"],
  next: SessionEntry["mcpServers"],
): boolean {
  if (current === next) return true;
  if (!current || !next || current.length !== next.length) return false;
  return current.every(
    (server, index) => server.name === next[index]?.name && server.status === next[index]?.status,
  );
}

export function handleMessage(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
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
      ? transitionTurn(currentSession.lifecycle, {
          type: "turn_ended",
          reason: "completed",
        })
      : transitionTurn(currentSession.lifecycle, { type: "stream_activity" });
  if (manualCompactBoundaryObserved && currentSession.pendingManualCompact) {
    patch.pendingManualCompact = false;
  }

  ctx.set(updateSession(ctx.get(), sessionId, patch));
}

export function handlePermissionRequest(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
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
 * Render a prompt another device sent on this feature (the remote-access
 * mirror). The sending device shows its own prompt optimistically and never
 * receives this echo — only passive viewers do — so we append a plain
 * user_message block with no client-message-id / delivery-state tracking.
 */
export function handleUserMessageMirror(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parseUserMessageMirrorPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  ctx.set(
    updateSession(
      ctx.get(),
      sessionId,
      appendLocalUserMessage(session, p.text, { origin: p.origin }),
    ),
  );
  // A fired scheduled message arrives as this mirror; its row is already marked
  // `sent` server-side, so refetch clears the pending card in lockstep with the
  // bubble appearing (instead of waiting for the next poll). Only refetch when a
  // pending row is actually cached — most mirrored messages aren't scheduled.
  if (session.featureId != null) {
    const queryKey = getGetScheduledMessageQueryKey(session.featureId);
    if (queryClient.getQueryData(queryKey) != null) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }
}

export function handlePromptReceived(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parsePromptReceivedPayload(payload);
  if (!p?.client_message_id) return;
  const session = ctx.getSession(sessionId);
  const blocks = markPromptReceived(session.blocks, p.client_message_id);
  if (blocks === session.blocks) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, blocksPatchWithDerived(session.streamingState, blocks)),
  );
}

export function handleCleared(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const session = ctx.get().sessions[sessionId];
  const existingBlocks = session?.blocks ?? [];
  const previousSessionId = parseClearedPayload(payload)?.previous_session_id ?? "";
  const clearedBlocks = [
    ...existingBlocks,
    {
      id: `clear-${Date.now()}`,
      type: "clear_divider" as const,
      content: previousSessionId,
    },
  ];
  // Reset streamingState (clear divider drops all in-flight streams) and
  // re-prime the derived rootBlocks/toolResultMap from the new blocks list.
  const freshState = createStreamingState();
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(freshState, clearedBlocks),
      lifecycle: transitionTurn(session?.lifecycle ?? { phase: "idle" }, {
        type: "turn_cleared",
      }),
      streamingState: freshState,
      historyPrependDisplayOffset: 0,
      pendingPermission: null,
      pendingPermissionQueue: [],
      pendingRequestId: "",
      pendingQuestions: [],
      pendingPlanApproval: null,
      hasFileChanges: false,
      runtimeSessionId: "",
      mcpServers: null,
    }),
  );
}
