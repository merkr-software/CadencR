import { createPermissionRespond, createPromptSend, type WsEnvelope } from "@/lib/ws-envelope";
import { getFeatureAgentState } from "@/api/generated";
import { AGENT_STATE_OLDER_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import type { DisplayRowMode } from "@/types/agent-stream";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-handler";
import { markLastPlanBlock, type PersistedStatePayload, updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import { prependHistoryBlocks } from "./ws-session-prepend";

export type { PersistedStatePayload };

export function applyApprovePlan(
  ctx: StoreAccessors,
  sessionId: string,
  sendRaw: (sessionId: string, envelope: WsEnvelope) => void,
  planRestorePrefix: string,
): void {
  const session = ctx.getSession(sessionId);
  const markedBlocks = markLastPlanBlock(session.blocks, "approved");
  const blocksPatch = blocksPatchWithDerived(session.streamingState, markedBlocks);
  const messageUuid = crypto.randomUUID();

  // The post-plan-approval mode change is owned by the backend bridge: it
  // calls `Query::set_permission_mode` on the live CLI atomically with
  // returning `Allow`, then broadcasts `mode.changed`. Any local write
  // here would race the CLI and let the chip lie about CLI state, so the
  // chip waits for that envelope instead (see no-optimistic-updates.md).

  if (session.pendingRequestId) {
    const isRestored = session.pendingRequestId.startsWith(planRestorePrefix);
    sendRaw(
      sessionId,
      createPermissionRespond(session.serverSessionId, session.pendingRequestId, "allow_once", {
        messageUuid,
      }),
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
  const blocksPatch = blocksPatchWithDerived(session.streamingState, blocksWithStatus);
  const messageUuid = crypto.randomUUID();

  if (session.pendingRequestId) {
    const isRestored = session.pendingRequestId.startsWith(planRestorePrefix);
    sendRaw(
      sessionId,
      createPermissionRespond(session.serverSessionId, session.pendingRequestId, "deny", {
        feedback,
        messageUuid,
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

export { applyPersistedState } from "./ws-session-persisted-actions";

/**
 * Upper bound of `before` pages fetched per load gesture while no new display
 * row appears. Under summary/compact display an agent-heavy page can collapse
 * entirely into an existing recap row, so a single page often renders nothing.
 */
const MAX_OLDER_PAGES_PER_LOAD = 10;

interface OlderPageResult {
  addedBlocks: number;
  addedDisplayRows: number;
  hasMore: boolean;
}

async function loadOlderSessionPage(
  ctx: StoreAccessors,
  sessionId: string,
  displayMode?: DisplayRowMode,
): Promise<OlderPageResult | null> {
  const session = ctx.get().sessions[sessionId];
  if (
    !session ||
    !session.hasMore ||
    session.oldestMessageId == null ||
    !session.featureId ||
    !session.sessionDbId
  )
    return null;

  const beforeParam = JSON.stringify({ [session.sessionDbId]: session.oldestMessageId });
  const data = await getFeatureAgentState(session.featureId, {
    before: beforeParam,
    limit: AGENT_STATE_OLDER_MESSAGE_LIMIT,
  });

  const serverSession = data.sessions.find((s) => s.sessionDbId === session.sessionDbId);
  if (!serverSession) {
    ctx.set(updateSession(ctx.get(), sessionId, { hasMore: false }));
    return null;
  }

  const olderBlocks = serverBlocksToAgentBlocks(serverSession.blocks as never[]);
  const hasMore = serverSession.hasMore ?? false;
  const added = prependHistoryBlocks(ctx, sessionId, olderBlocks, displayMode, {
    hasMore,
    oldestMessageId: serverSession.oldestMessageId ?? null,
  });
  if (!added) return null;
  return { ...added, hasMore };
}

/**
 * Load older messages for a session from the server. Returns the number of
 * blocks that were prepended. The store also tracks the rendered display-row
 * delta so Virtuoso can preserve scroll position via `firstItemIndex`.
 *
 * Fetches pages (bounded by `MAX_OLDER_PAGES_PER_LOAD`) until one adds a
 * visible row or history runs out, so a collapsing page never reads as a
 * dead scroll-up.
 */
export async function loadOlderSessionMessages(
  ctx: StoreAccessors,
  sessionId: string,
  displayMode?: DisplayRowMode,
): Promise<number> {
  let totalAddedBlocks = 0;
  for (let page = 0; page < MAX_OLDER_PAGES_PER_LOAD; page += 1) {
    const result = await loadOlderSessionPage(ctx, sessionId, displayMode);
    if (!result) break;
    totalAddedBlocks += result.addedBlocks;
    if (result.addedDisplayRows > 0 || !result.hasMore) break;
  }
  return totalAddedBlocks;
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
