import { createPermissionRespond, createPromptSend, type WsEnvelope } from "@/lib/ws-envelope";
import { getFeatureAgentState } from "@/api/generated";
import { AGENT_STATE_OLDER_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import { upsertPendingPermission } from "@/lib/pending-permission-queue";
import { parseAskUserQuestions, type AgentQuestion } from "@/components/AgentQuestionDrawer";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";
import { countRenderableDisplayRows, type DisplayRowMode } from "@/components/agentStreamDisplay";
import {
  blocksPatchWithDerived,
  injectPlanIntoBlocks,
  parseTodosFromBlocks,
} from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parsePermissionPayload } from "./ws-envelope-payload";
import { trimTailPromptTurnBoundary } from "./ws-pending-prompts";
import {
  markLastPlanBlock,
  type PersistedStatePayload,
  type SessionEntry,
  updateSession,
} from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { parseCodexPermissionMode } from "@/types/codex-permission-mode";

export type { PersistedStatePayload };

interface DecodedQuestion {
  questions: AgentQuestion[];
  toolInput: Record<string, unknown>;
  requestId: string;
}

// `pending_permission` and `pending_questions` are filtered by tool_name so a
// payload mis-routed into the wrong column (or stored under a tool the other
// gate owns) doesn't double-render. The plan-approval and question gates
// have their own columns and code paths.
function decodeSnapshotPermission(value: unknown): PendingPermission | null {
  const parsed = parsePermissionPayload(value);
  if (!parsed?.request_id || !parsed.tool_name) return null;
  if (parsed.tool_name === "ExitPlanMode" || parsed.tool_name === "AskUserQuestion") return null;
  return {
    toolName: parsed.tool_name,
    input: parsed.tool_input,
    description: parsed.description ?? "",
    pattern: parsed.pattern ?? "",
    preview: parsed.preview,
    options: parsed.options,
    requestId: parsed.request_id,
  };
}

function decodeSnapshotQuestion(value: unknown): DecodedQuestion | null {
  const parsed = parsePermissionPayload(value);
  if (!parsed?.request_id) return null;
  const questions = parseAskUserQuestions(parsed.tool_input);
  if (questions.length === 0) return null;
  return { questions, toolInput: parsed.tool_input, requestId: parsed.request_id };
}

export function applyApprovePlan(
  ctx: StoreAccessors,
  sessionId: string,
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void,
  planRestorePrefix: string,
): void {
  const session = ctx.getSession(sessionId);
  const markedBlocks = markLastPlanBlock(session.blocks, "approved");
  session.streamingState.counter += 1;
  const updatedBlocks = [
    ...markedBlocks,
    {
      id: `ws-user-${session.streamingState.counter}`,
      type: "user_message" as const,
      content: "Plan approved.",
      isError: false,
      createdAt: new Date().toISOString(),
    },
  ];

  const blocksPatch = blocksPatchWithDerived(session.streamingState, updatedBlocks);

  // The post-plan-approval mode change is owned by the backend bridge: it
  // calls `Query::set_permission_mode` on the live CLI atomically with
  // returning `Allow`, then broadcasts `mode.changed`. Any local write
  // here would race the CLI and let the chip lie about CLI state, so the
  // chip waits for that envelope instead (see no-optimistic-updates.md).

  if (session.pendingRequestId) {
    const isRestored = session.pendingRequestId.startsWith(planRestorePrefix);
    sendRaw(
      sessionId,
      createPermissionRespond(session.serverSessionId, session.pendingRequestId, "allow_once"),
    );
    if (isRestored) {
      sendRaw(
        sessionId,
        createPromptSend(session.serverSessionId, "Plan approved. Proceed with execution."),
      );
    }
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        pendingRequestId: "",
        pendingPlanApproval: null,
        ...blocksPatch,
        lifecycle: transitionTurn(session.lifecycle, { type: "plan_approved" }),
      }),
    );
    return;
  }

  sendRaw(
    sessionId,
    createPromptSend(
      session.serverSessionId,
      "Plan approved. Exit plan mode and proceed with execution.",
    ),
  );
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      pendingPlanApproval: null,
      ...blocksPatch,
      lifecycle: transitionTurn(session.lifecycle, { type: "plan_approved" }),
    }),
  );
}

export function applyPlanChangesRequest(
  ctx: StoreAccessors,
  sessionId: string,
  feedback: string,
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void,
  planRestorePrefix: string,
): void {
  const session = ctx.getSession(sessionId);
  const blocksWithStatus = markLastPlanBlock(session.blocks, "rejected");
  session.streamingState.counter += 1;
  const blocksWithFeedback = feedback
    ? [
        ...blocksWithStatus,
        {
          id: `ws-user-${session.streamingState.counter}`,
          type: "user_message" as const,
          content: feedback,
          isError: false,
          createdAt: new Date().toISOString(),
        },
      ]
    : blocksWithStatus;

  const blocksPatch = blocksPatchWithDerived(session.streamingState, blocksWithFeedback);

  if (session.pendingRequestId) {
    const isRestored = session.pendingRequestId.startsWith(planRestorePrefix);
    sendRaw(
      sessionId,
      createPermissionRespond(session.serverSessionId, session.pendingRequestId, "deny", {
        feedback,
      }),
    );
    if (isRestored) {
      sendRaw(
        sessionId,
        createPromptSend(session.serverSessionId, feedback || "Plan rejected. Revise the plan."),
      );
    }
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        pendingRequestId: "",
        pendingPlanApproval: null,
        ...blocksPatch,
        lifecycle: transitionTurn(session.lifecycle, { type: "plan_changes_requested" }),
      }),
    );
    return;
  }

  sendRaw(sessionId, createPromptSend(session.serverSessionId, feedback));
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      pendingPlanApproval: null,
      ...blocksPatch,
      lifecycle: transitionTurn(session.lifecycle, { type: "plan_changes_requested" }),
    }),
  );
}

export function applyPersistedState(
  ctx: StoreAccessors,
  sessionId: string,
  payload: PersistedStatePayload,
  planRestorePrefix: string,
): void {
  const {
    blocks,
    lifecycle,
    hasMore,
    oldestMessageId,
    maxMessageId,
    featureId,
    sessionDbId,
    currentProviderId,
    currentModelId,
    currentProfile,
    runtimeProvider,
    runtimeSessionId,
    permissionMode,
    codexPermissionMode,
    pendingPlanApproval,
    pendingPermission: pendingPermissionSnapshot,
    pendingQuestions: pendingQuestionsSnapshot,
    contextUsage,
    hasFileChanges,
  } = payload;

  const resolvedProviderId = currentProviderId ?? runtimeProvider ?? undefined;
  const resolvedRuntimeProvider = runtimeProvider ?? currentProviderId ?? undefined;
  const resolvedRuntimeSessionId = runtimeSessionId ?? undefined;
  const existing = ctx.get().sessions[sessionId];

  // Race guard: a live `permission.request` envelope can arrive before the
  // REST snapshot resolves; the live state is always fresher.
  const canHydrateFromSnapshot = (existing?.pendingRequestId ?? "") === "";
  const decodedPermission =
    canHydrateFromSnapshot && pendingPermissionSnapshot != null
      ? decodeSnapshotPermission(pendingPermissionSnapshot)
      : null;
  const decodedQuestion =
    canHydrateFromSnapshot && pendingQuestionsSnapshot != null
      ? decodeSnapshotQuestion(pendingQuestionsSnapshot)
      : null;

  let lifecycleWithPendingGate = lifecycle;
  if (pendingPlanApproval != null) {
    lifecycleWithPendingGate = transitionTurn(lifecycle, { type: "plan_approval_requested" });
  } else if (decodedPermission) {
    lifecycleWithPendingGate = transitionTurn(lifecycle, { type: "permission_requested" });
  } else if (decodedQuestion) {
    lifecycleWithPendingGate = transitionTurn(lifecycle, { type: "question_requested" });
  }

  const permissionQueuePatch = decodedPermission
    ? upsertPendingPermission(
        existing ?? { pendingPermission: null, pendingPermissionQueue: [] },
        decodedPermission,
      )
    : null;

  const restoredRequestId = decodedPermission?.requestId
    ? decodedPermission.requestId
    : decodedQuestion
      ? decodedQuestion.requestId
      : pendingPlanApproval != null
        ? existing?.pendingRequestId || `${planRestorePrefix}${Date.now()}`
        : "";

  const tailPromptBoundary =
    existing && existing.blocks.length > 0 ? trimTailPromptTurnBoundary(existing.blocks) : null;
  const shouldPreservePromptLifecycle =
    tailPromptBoundary?.shouldTrim === true &&
    lifecycleWithPendingGate.phase === "terminal" &&
    lifecycleWithPendingGate.reason === "completed";
  const sessionMetaPatch: Partial<SessionEntry> = {
    persistedLoaded: true,
    historyPrependDisplayOffset: 0,
    hasMore: hasMore ?? false,
    oldestMessageId: oldestMessageId ?? null,
    lastAppliedMessageId: maxMessageId ?? null,
    featureId: featureId ?? null,
    sessionDbId: sessionDbId ?? null,
    lifecycle:
      shouldPreservePromptLifecycle && existing ? existing.lifecycle : lifecycleWithPendingGate,
    ...(resolvedProviderId ? { currentProviderId: resolvedProviderId } : {}),
    ...(currentModelId ? { currentModelId } : {}),
    ...(currentProfile ? { currentProfile } : {}),
    // Rehydrate the persisted permission mode so sticky modes (notably
    // `bypassPermissions`) survive a store re-seed — app relaunch, dev HMR
    // reload, or a session entry rebuilt after a dropped connection. Without
    // this the entry keeps the `createSessionEntry` default (`acceptEdits`)
    // and the mode silently reverts. Mirrors `codexPermissionMode` above.
    ...(permissionMode ? { permissionMode } : {}),
    ...(codexPermissionMode
      ? { codexPermissionMode: parseCodexPermissionMode(codexPermissionMode) }
      : {}),
    ...(resolvedRuntimeProvider ? { runtimeProvider: resolvedRuntimeProvider } : {}),
    ...(resolvedRuntimeSessionId ? { runtimeSessionId: resolvedRuntimeSessionId } : {}),
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    ...(hasFileChanges !== undefined ? { hasFileChanges } : {}),
    ...(pendingPlanApproval != null ? { pendingPlanApproval } : {}),
    ...(permissionQueuePatch
      ? {
          pendingPermission: permissionQueuePatch.pendingPermission,
          pendingPermissionQueue: permissionQueuePatch.pendingPermissionQueue,
        }
      : {}),
    ...(decodedQuestion
      ? {
          pendingQuestions: decodedQuestion.questions,
          pendingQuestionToolInput: decodedQuestion.toolInput,
        }
      : {}),
    ...(restoredRequestId !== "" ? { pendingRequestId: restoredRequestId } : {}),
  };

  if (existing && existing.blocks.length > 0) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        ...sessionMetaPatch,
        ...(tailPromptBoundary?.shouldTrim && tailPromptBoundary.blocks !== existing.blocks
          ? blocksPatchWithDerived(existing.streamingState, tailPromptBoundary.blocks)
          : {}),
      }),
    );
    return;
  }

  const enrichedBlocks = injectPlanIntoBlocks(blocks, pendingPlanApproval);
  const todos = parseTodosFromBlocks(enrichedBlocks);
  const session = ctx.getSession(sessionId);

  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...sessionMetaPatch,
      ...blocksPatchWithDerived(session.streamingState, enrichedBlocks),
      ...(todos ? { todos } : {}),
    }),
  );
}

/**
 * Load older messages for a session from the server. Returns the number of
 * blocks that were prepended. The store also tracks the rendered display-row
 * delta so Virtuoso can preserve scroll position via `firstItemIndex`.
 */
export async function loadOlderSessionMessages(
  ctx: StoreAccessors,
  sessionId: string,
  displayMode?: DisplayRowMode,
): Promise<number> {
  const session = ctx.get().sessions[sessionId];
  if (
    !session ||
    !session.hasMore ||
    session.oldestMessageId == null ||
    !session.featureId ||
    !session.sessionDbId
  )
    return 0;

  const beforeParam = JSON.stringify({ [session.sessionDbId]: session.oldestMessageId });
  const data = await getFeatureAgentState(session.featureId, {
    before: beforeParam,
    limit: AGENT_STATE_OLDER_MESSAGE_LIMIT,
  });

  const serverSession = data.sessions.find((s) => s.sessionDbId === session.sessionDbId);
  if (!serverSession) {
    ctx.set(updateSession(ctx.get(), sessionId, { hasMore: false }));
    return 0;
  }

  const olderBlocks = serverBlocksToAgentBlocks(serverSession.blocks as never[]);
  const currentSession = ctx.get().sessions[sessionId];
  if (!currentSession) return 0;
  const mergedBlocks = [...olderBlocks, ...currentSession.blocks];
  // Use the actual growth in rendered rows, not the older chunk's rows in
  // isolation — under summary/compact mode a segment can span the chunk
  // boundary, so the net delta is what keeps `firstItemIndex` aligned.
  const prependedDisplayRows =
    countRenderableDisplayRows(mergedBlocks, displayMode) -
    countRenderableDisplayRows(currentSession.blocks, displayMode);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(currentSession.streamingState, mergedBlocks),
      historyPrependDisplayOffset:
        currentSession.historyPrependDisplayOffset + prependedDisplayRows,
      hasMore: serverSession.hasMore ?? false,
      oldestMessageId: serverSession.oldestMessageId ?? null,
    }),
  );
  return olderBlocks.length;
}

/** Format question answers into a user-visible markdown string. */
export function formatQuestionResponse(
  pendingQuestionToolInput: Record<string, unknown>,
  response: Array<string[]>,
): string {
  const questions = Array.isArray(pendingQuestionToolInput.questions)
    ? pendingQuestionToolInput.questions
    : pendingQuestionToolInput.question != null
      ? [pendingQuestionToolInput]
      : [];
  return response
    .map((answerGroup, index) => {
      const rawQuestion = questions[index] as Record<string, unknown> | undefined;
      const question =
        typeof rawQuestion === "object" &&
        rawQuestion != null &&
        typeof rawQuestion.question === "string"
          ? (rawQuestion.question as string)
          : `Question ${index + 1}`;
      return `*${question}*\n\n**${answerGroup.join("\n")}**`;
    })
    .join("\n\n\n\n");
}
