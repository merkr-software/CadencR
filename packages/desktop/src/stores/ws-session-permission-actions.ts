import type { StoreApi } from "zustand";
import { createPermissionRespond } from "@/lib/ws-envelope";
import { advancePendingPermissionQueue } from "@/lib/pending-permission-queue";
import { buildAskUserQuestionUpdatedInput } from "@/lib/build-ask-user-question-payload";
import type { AgentQuestionAnswers } from "@/components/agent-question/types";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import { makeErrorBlock } from "./ws-session-store-helpers";
import { blocksPatchWithDerived } from "./ws-message-processing";
import { transitionTurn } from "./ws-turn-lifecycle";
import {
  markLastPlanBlock,
  updateSession,
  type SessionEntry,
  type WsSessionStore,
} from "./ws-session-types";
type WsStoreSet = (partial: Partial<WsSessionStore>) => void;
type WsStoreGet = StoreApi<WsSessionStore>["getState"];
type PermissionDecision = Parameters<typeof createPermissionRespond>[2];
type PermissionOptions = Parameters<typeof createPermissionRespond>[3];
export type PlanOutcome = "approved" | "rejected";

/** Mark the plan with the backend-accepted outcome and leave its gate. */
function resolvedPlanPatch(session: SessionEntry, outcome: PlanOutcome): Partial<SessionEntry> {
  return {
    ...blocksPatchWithDerived(session.streamingState, markLastPlanBlock(session.blocks, outcome)),
    pendingPlanApproval: null,
    lifecycle: transitionTurn(session.lifecycle, {
      type: outcome === "approved" ? "plan_approved" : "plan_changes_requested",
    }),
  };
}

function handlePermissionResponse(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  currentRequestId: string,
  payload: unknown,
  planOutcome?: PlanOutcome,
): void {
  const session = get().sessions[sessionId];
  if (!session) return;
  const error = parseErrorPayload(payload);
  const failed = Boolean(error?.message) || payload === null;
  if (session.pendingRequestId !== currentRequestId) {
    // The gate already left through another path (the app socket clears it
    // once the backend reports the session out of "question"); an accepted
    // plan decision still has to mark the plan block, unless a newer plan is
    // already waiting.
    const planPatch =
      planOutcome && !failed && session.pendingPlanApproval == null
        ? blocksPatchWithDerived(
            session.streamingState,
            markLastPlanBlock(session.blocks, planOutcome),
          )
        : null;
    if (session.permissionResponseMessageUuids.has(currentRequestId) || planPatch) {
      const responseUuids = new Map(session.permissionResponseMessageUuids);
      responseUuids.delete(currentRequestId);
      set(
        updateSession(get(), sessionId, {
          ...planPatch,
          permissionResponseMessageUuids: responseUuids,
        }),
      );
    }
    return;
  }
  if (failed) {
    const message = error?.message ?? "Permission response timed out.";
    const errorBlock = makeErrorBlock(session, message, { idPrefix: "ws-permission-error" });
    const isDeadSessionError = isGateClosingErrorCode(error?.code);
    const responseUuids = new Map(session.permissionResponseMessageUuids);
    if (isDeadSessionError) responseUuids.delete(currentRequestId);
    const gatePatch: Partial<SessionEntry> = isDeadSessionError
      ? {
          ...buildClearedGatePatch(session),
          lifecycle: transitionTurn(session.lifecycle, { type: "turn_errored", message }),
        }
      : { submittingPermissionRequestId: null };
    set(
      updateSession(get(), sessionId, {
        ...blocksPatchWithDerived(session.streamingState, [...session.blocks, errorBlock]),
        ...gatePatch,
        permissionResponseMessageUuids: responseUuids,
      }),
    );
    return;
  }
  const responseUuids = new Map(session.permissionResponseMessageUuids);
  responseUuids.delete(currentRequestId);
  const permissionPatch: Partial<SessionEntry> = planOutcome
    ? resolvedPlanPatch(session, planOutcome)
    : session.pendingQuestions.length > 0
      ? {
          ...buildClearedGatePatch(session),
          lifecycle: transitionTurn(session.lifecycle, { type: "question_answered" }),
        }
      : advancePendingPermissionQueue(session.pendingPermissionQueue);
  set(
    updateSession(get(), sessionId, {
      ...permissionPatch,
      pendingRequestId: permissionPatch.pendingPermission?.requestId ?? "",
      submittingPermissionRequestId: null,
      permissionResponseMessageUuids: responseUuids,
    }),
  );
}

/**
 * Send a gate decision and settle the gate only once the backend answers:
 * `submittingPermissionRequestId` drives the loader meanwhile, and the
 * message uuid is kept so a retry stays idempotent.
 */
function submitResponse(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  requestId: string,
  decision: PermissionDecision,
  options: PermissionOptions,
  planOutcome?: PlanOutcome,
): void {
  const session = get().sessions[sessionId];
  if (!session || !requestId || session.submittingPermissionRequestId === requestId) return;
  const permissionResponseMessageUuids = new Map(session.permissionResponseMessageUuids);
  const messageUuid = permissionResponseMessageUuids.get(requestId) ?? crypto.randomUUID();
  permissionResponseMessageUuids.set(requestId, messageUuid);
  const envelope = createPermissionRespond(session.serverSessionId, requestId, decision, {
    ...options,
    messageUuid,
  });
  set(
    updateSession(get(), sessionId, {
      submittingPermissionRequestId: requestId,
      permissionResponseMessageUuids,
    }),
  );
  void get()
    .sendRequest(sessionId, envelope)
    .then((payload) =>
      handlePermissionResponse(set, get, sessionId, requestId, payload, planOutcome),
    );
}

/** Answer a live plan gate: approve it, or deny it with change requests. */
export function submitPlanResponse(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  requestId: string,
  outcome: PlanOutcome,
  feedback: string,
): void {
  if (outcome === "approved") {
    submitResponse(set, get, sessionId, requestId, "allow_once", {}, outcome);
    return;
  }
  submitResponse(set, get, sessionId, requestId, "deny", { feedback }, outcome);
}

export function createPermissionActions(
  set: WsStoreSet,
  get: WsStoreGet,
): Pick<WsSessionStore, "respondToPermission" | "respondToQuestion"> {
  return {
    respondToPermission(sessionId, requestId, decision, feedback, optionId) {
      const session = get().sessions[sessionId];
      submitResponse(
        set,
        get,
        sessionId,
        session?.pendingPermission?.requestId ?? requestId,
        decision,
        {
          feedback,
          optionId,
        },
      );
    },
    respondToQuestion(sessionId, response: AgentQuestionAnswers) {
      const session = get().sessions[sessionId];
      if (!session || session.pendingQuestions.length === 0) return;
      submitResponse(set, get, sessionId, session.pendingRequestId, "allow_once", {
        updatedInput: buildAskUserQuestionUpdatedInput(session.pendingQuestionToolInput, response),
      });
    },
  };
}
