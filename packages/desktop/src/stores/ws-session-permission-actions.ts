import type { StoreApi } from "zustand";
import { createPermissionRespond } from "@/lib/ws-envelope";
import { advancePendingPermissionQueue } from "@/lib/pending-permission-queue";
import { buildAskUserQuestionUpdatedInput } from "@/lib/build-ask-user-question-payload";
import type { AgentQuestionAnswers } from "@/types/agent-question";
import { parseErrorPayload } from "./ws-envelope-payload";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import { makeErrorBlock } from "./ws-session-store-helpers";
import { blocksPatchWithDerived } from "./ws-message-processing";
import { transitionTurn } from "./ws-turn-lifecycle";
import { updateSession, type SessionEntry, type WsSessionStore } from "./ws-session-types";
type WsStoreSet = StoreApi<WsSessionStore>["setState"];
type WsStoreGet = StoreApi<WsSessionStore>["getState"];

function handlePermissionResponse(
  set: WsStoreSet,
  get: WsStoreGet,
  sessionId: string,
  currentRequestId: string,
  payload: unknown,
): void {
  const session = get().sessions[sessionId];
  if (!session) return;
  if (session.pendingRequestId !== currentRequestId) {
    if (session.permissionResponseMessageUuids.has(currentRequestId)) {
      const responseUuids = new Map(session.permissionResponseMessageUuids);
      responseUuids.delete(currentRequestId);
      set(updateSession(get(), sessionId, { permissionResponseMessageUuids: responseUuids }));
    }
    return;
  }
  const error = parseErrorPayload(payload);
  if (error?.message || payload === null) {
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
  const permissionPatch =
    session.pendingQuestions.length > 0
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

export function createPermissionActions(
  set: WsStoreSet,
  get: WsStoreGet,
): Pick<WsSessionStore, "respondToPermission" | "respondToQuestion"> {
  function submitResponse(
    sessionId: string,
    requestId: string,
    decision: Parameters<typeof createPermissionRespond>[2],
    options: Parameters<typeof createPermissionRespond>[3],
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
      .then((payload) => handlePermissionResponse(set, get, sessionId, requestId, payload));
  }
  return {
    respondToPermission(sessionId, requestId, decision, feedback, optionId) {
      const session = get().sessions[sessionId];
      submitResponse(sessionId, session?.pendingPermission?.requestId ?? requestId, decision, {
        feedback,
        optionId,
      });
    },
    respondToQuestion(sessionId, response: AgentQuestionAnswers) {
      const session = get().sessions[sessionId];
      if (!session || session.pendingQuestions.length === 0) return;
      submitResponse(sessionId, session.pendingRequestId, "allow_once", {
        updatedInput: buildAskUserQuestionUpdatedInput(session.pendingQuestionToolInput, response),
      });
    },
  };
}
