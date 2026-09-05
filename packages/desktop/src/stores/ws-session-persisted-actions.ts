import { upsertPendingPermission } from "@/lib/pending-permission-queue";
import { parseAskUserQuestions, type AgentQuestion } from "@/components/AgentQuestionDrawer";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";
import {
  blocksPatchWithDerived,
  injectPlanIntoBlocks,
  parseTodosFromBlocks,
} from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-handler";
import { parsePermissionPayload } from "./ws-envelope-payload";
import { movePendingPromptBlocksToTail, trimTailPromptTurnBoundary } from "./ws-pending-prompts";
import { type PersistedStatePayload, type SessionEntry, updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { parseAccessMode } from "@/types/access-mode";
import { mergeCanonicalBlocks } from "./ws-user-message-reconciliation";

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

interface SessionMetaPatchOptions {
  payload: PersistedStatePayload;
  existing: SessionEntry | undefined;
  lifecycleWithPendingGate: PersistedStatePayload["lifecycle"];
  shouldPreservePromptLifecycle: boolean;
  permissionQueuePatch: ReturnType<typeof upsertPendingPermission> | null;
  decodedQuestion: DecodedQuestion | null;
  restoredRequestId: string;
}

function buildSessionMetaPatch(options: SessionMetaPatchOptions): Partial<SessionEntry> {
  const {
    payload,
    existing,
    lifecycleWithPendingGate,
    shouldPreservePromptLifecycle,
    permissionQueuePatch,
    decodedQuestion,
    restoredRequestId,
  } = options;
  // Race guard: a live WS `initialized` envelope can confirm the selection
  // before this REST snapshot resolves; once a serverSessionId is set, the
  // live value is always fresher, so a stale snapshot must never clobber it.
  const canHydrateSelection = !existing?.serverSessionId;
  const resolvedSelection = payload.currentSelection
    ? payload.currentSelection
    : payload.currentProviderId && payload.currentModelId
      ? { providerId: payload.currentProviderId, modelId: payload.currentModelId }
      : undefined;
  return {
    persistedLoaded: true,
    historyPrependDisplayOffset: 0,
    hasMore: payload.hasMore ?? false,
    oldestMessageId: payload.oldestMessageId ?? null,
    lastAppliedMessageId: payload.maxMessageId ?? null,
    featureId: payload.featureId ?? null,
    sessionDbId: payload.sessionDbId ?? null,
    lifecycle:
      shouldPreservePromptLifecycle && existing ? existing.lifecycle : lifecycleWithPendingGate,
    ...(canHydrateSelection && resolvedSelection ? { currentSelection: resolvedSelection } : {}),
    ...(payload.currentProfile ? { currentProfile: payload.currentProfile } : {}),
    ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
    ...(payload.accessMode ? { accessMode: parseAccessMode(payload.accessMode) } : {}),
    ...(payload.runtimeSessionId ? { runtimeSessionId: payload.runtimeSessionId } : {}),
    ...(payload.contextUsage !== undefined ? { contextUsage: payload.contextUsage } : {}),
    ...(payload.hasFileChanges !== undefined ? { hasFileChanges: payload.hasFileChanges } : {}),
    ...(payload.pendingPlanApproval != null
      ? { pendingPlanApproval: payload.pendingPlanApproval }
      : {}),
    ...(permissionQueuePatch ?? {}),
    ...(decodedQuestion
      ? {
          pendingQuestions: decodedQuestion.questions,
          pendingQuestionToolInput: decodedQuestion.toolInput,
        }
      : {}),
    ...(restoredRequestId !== "" ? { pendingRequestId: restoredRequestId } : {}),
  };
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
    pendingPlanApproval,
    pendingPermission: pendingPermissionSnapshot,
    pendingQuestions: pendingQuestionsSnapshot,
  } = payload;

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
  const sessionMetaPatch = buildSessionMetaPatch({
    payload,
    existing,
    lifecycleWithPendingGate,
    shouldPreservePromptLifecycle,
    permissionQueuePatch,
    decodedQuestion,
    restoredRequestId,
  });

  const enrichedBlocks = injectPlanIntoBlocks(blocks, pendingPlanApproval);
  if (existing && existing.blocks.length > 0) {
    const liveBlocks = tailPromptBoundary?.blocks ?? existing.blocks;
    const mergedBlocks = mergeCanonicalBlocks(liveBlocks, enrichedBlocks);
    const todos = parseTodosFromBlocks(mergedBlocks);
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        ...sessionMetaPatch,
        ...(mergedBlocks !== existing.blocks
          ? blocksPatchWithDerived(existing.streamingState, mergedBlocks)
          : {}),
        ...(todos ? { todos } : {}),
      }),
    );
    return;
  }

  const orderedBlocks = movePendingPromptBlocksToTail(enrichedBlocks);
  const todos = parseTodosFromBlocks(orderedBlocks);
  const session = ctx.getSession(sessionId);

  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...sessionMetaPatch,
      ...blocksPatchWithDerived(session.streamingState, orderedBlocks),
      ...(todos ? { todos } : {}),
    }),
  );
}
