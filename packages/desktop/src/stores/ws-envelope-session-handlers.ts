import type { AgentQuestion } from "@/components/AgentQuestionDrawer";
import { parseAskUserQuestions } from "@/components/AgentQuestionDrawer";
import {
  parseClearedPayload,
  parseCompactingPayload,
  parseGateClosedPayload,
  parseInitializedPayload,
  parseMcpServersPayload,
  parsePermissionPayload,
  parsePromptReceivedPayload,
  parseCanonicalUserMessagePayload,
} from "./ws-envelope-payload";
import { upsertCanonicalUserMessage } from "./ws-user-message-reconciliation";
import { buildClearedGatePatch } from "./ws-gate-state";
import { blocksPatchWithDerived, createStreamingState } from "./ws-message-processing";
import { normalizeContextWindow } from "@/types/agent";
import { parseAccessMode } from "@/types/access-mode";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { upsertPendingPermission } from "@/lib/pending-permission-queue";
import { appendErrorBlockPatch } from "./ws-session-store-helpers";
import { markPromptDeliveryFailed, markPromptReceived } from "./ws-pending-prompts";
import type { StoreAccessors } from "./ws-envelope-types";
import { queryClient } from "@/lib/queryClient";
import { getListSchedulesQueryKey } from "@/api/generated";
// Re-exported so the envelope dispatch table keeps importing `handleMessage`
// from here; the implementation moved to `ws-message-envelope-handler.ts`.
export { handleMessage } from "./ws-message-envelope-handler";

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
  if (p.provider || p.model) {
    updates.currentProviderId = p.provider ?? "";
    updates.currentModelId = p.model ?? "";
    updates.runtimeProvider = p.provider ?? "";
  } else {
    updates.runtimeProvider = session.currentProviderId;
  }
  if (p.profile) updates.currentProfile = p.profile;
  const accessMode = p.access_mode ?? p.codex_permission_mode;
  if (accessMode) {
    updates.accessMode = parseAccessMode(accessMode);
  }
  updates.currentThinkingEffort = p.thinking_effort;
  if (p.input_tokens != null || p.output_tokens != null) {
    // Same rule as `session.usage_update`: this payload is a complete snapshot
    // read from the session row, so an absent window means unknown. Falling
    // back to the in-memory one would let a reconnect resurrect a window a
    // model switch had already retracted.
    updates.contextUsage = {
      inputTokens: p.input_tokens ?? 0,
      outputTokens: p.output_tokens ?? 0,
      contextWindow: normalizeContextWindow(p.context_window),
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
 * Upsert the backend-confirmed user message. The sender and passive viewers
 * consume this exact same persisted event; no renderer creates a competing
 * local user-message identity.
 */
export function handleCanonicalUserMessage(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parseCanonicalUserMessagePayload(payload);
  if (!p) {
    console.warn("[ws-session] dropped malformed canonical user_message envelope", payload);
    const session = ctx.getSession(sessionId);
    ctx.set(
      updateSession(
        ctx.get(),
        sessionId,
        appendErrorBlockPatch(
          session,
          "A persisted user message could not be displayed because its live event was malformed. Reconnect to reload the canonical transcript.",
          { code: "MALFORMED_USER_MESSAGE" },
        ),
      ),
    );
    return;
  }
  const session = ctx.getSession(sessionId);
  const blocks = upsertCanonicalUserMessage(session.blocks, p);
  if (blocks !== session.blocks) {
    ctx.set(
      updateSession(ctx.get(), sessionId, blocksPatchWithDerived(session.streamingState, blocks)),
    );
  }
  refreshSchedulesIfAny();
}

/**
 * A fired schedule arrives as a normal user message; its row has already rolled
 * forward server-side, so refetching here moves the composer banner in lockstep
 * with the bubble appearing instead of waiting for the next poll.
 *
 * Guarded on something actually being cached: most user messages aren't
 * scheduled, and this runs on every one of them. The key is the param-less
 * prefix, which react-query matches every list variant by.
 */
function refreshSchedulesIfAny(): void {
  const queryKey = getListSchedulesQueryKey();
  const cached = queryClient.getQueriesData<unknown[]>({ queryKey });
  if (!cached.some(([, data]) => Array.isArray(data) && data.length > 0)) return;
  void queryClient.invalidateQueries({ queryKey });
}

export function handlePromptReceived(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parsePromptReceivedPayload(payload);
  if (!p) return;
  const session = ctx.getSession(sessionId);
  const blocks =
    p.delivery_state === "delivery_failed"
      ? markPromptDeliveryFailed(session.blocks, p.message_uuid)
      : markPromptReceived(session.blocks, p.message_uuid);
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
