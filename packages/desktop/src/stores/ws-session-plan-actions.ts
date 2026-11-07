/**
 * Plan approval / change requests, answered like every other gate: the click
 * marks the decision in flight (`submittingPermissionRequestId`, the same
 * "submitting" state permissions use) and the gate, the plan block, and the
 * turn lifecycle change only once the backend confirms (no-optimistic-updates).
 *
 * `permission.respond` is a request; its correlated acknowledgement closes the
 * gate, an error leaves it open with the reason. A plan restored after its
 * agent process ended is answered the same way: the backend tells the agent
 * the decision itself, so the client never writes a prompt for it.
 */
import { createPermissionRespond } from "@/lib/ws-envelope";
import { parseErrorPayload } from "./ws-envelope-payload";
import type { StoreAccessors } from "./ws-envelope-types";
import { buildClearedGatePatch, isGateClosingErrorCode } from "./ws-gate-state";
import { blocksPatchWithDerived } from "./ws-message-processing";
import { appendErrorBlockPatch } from "./ws-session-store-helpers";
import { responseMessageUuid } from "./ws-session-permission-actions";
import { markLastPlanBlock, updateSession, type SessionEntry } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";

export type PlanDecision = "approved" | "rejected";

/** The confirmed outcome: plan block marked, gate closed, turn resumed. */
function confirmedPlanPatch(session: SessionEntry, decision: PlanDecision): Partial<SessionEntry> {
  return {
    ...buildClearedGatePatch(session),
    ...blocksPatchWithDerived(session.streamingState, markLastPlanBlock(session.blocks, decision)),
    lifecycle: transitionTurn(session.lifecycle, {
      type: decision === "approved" ? "plan_approved" : "plan_changes_requested",
    }),
  };
}

function handlePlanResponse(
  ctx: StoreAccessors,
  sessionId: string,
  requestId: string,
  decision: PlanDecision,
  payload: unknown,
): void {
  const session = ctx.get().sessions[sessionId];
  if (!session) return;
  const error = parseErrorPayload(payload);
  const waiting = session.submittingPermissionRequestId === requestId;
  const permissionResponseMessageUuids = new Map(session.permissionResponseMessageUuids);
  if (!error?.message && payload !== null) {
    permissionResponseMessageUuids.delete(requestId);
    if (waiting) {
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          ...confirmedPlanPatch(session, decision),
          permissionResponseMessageUuids,
        }),
      );
    } else if (session.pendingRequestId === "") {
      // The app socket's status update closed the gate first; only the plan's
      // outcome is left to record.
      const blocks = markLastPlanBlock(session.blocks, decision);
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          ...blocksPatchWithDerived(session.streamingState, blocks),
          permissionResponseMessageUuids,
        }),
      );
    }
    return;
  }
  if (!waiting) return;
  const message = error?.message ?? "The plan response timed out.";
  const closesGate = isGateClosingErrorCode(error?.code);
  if (closesGate) permissionResponseMessageUuids.delete(requestId);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...appendErrorBlockPatch(session, message, { idPrefix: "ws-plan-error" }),
      ...(closesGate ? buildClearedGatePatch(session) : {}),
      submittingPermissionRequestId: null,
      permissionResponseMessageUuids,
    }),
  );
}

export function submitPlanDecision(
  ctx: StoreAccessors,
  sessionId: string,
  decision: PlanDecision,
  feedback: string,
): void {
  const session = ctx.get().sessions[sessionId];
  if (!session || session.submittingPermissionRequestId != null) return;
  const requestId = session.pendingRequestId;
  if (!requestId) return;
  const { messageUuid, permissionResponseMessageUuids } = responseMessageUuid(session, requestId);
  const envelope = createPermissionRespond(
    session.serverSessionId,
    requestId,
    decision === "approved" ? "allow_once" : "deny",
    { messageUuid, ...(decision === "rejected" ? { feedback } : {}) },
  );
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      submittingPermissionRequestId: requestId,
      permissionResponseMessageUuids,
    }),
  );
  void ctx
    .get()
    .sendRequest(sessionId, envelope)
    .then((payload) => handlePlanResponse(ctx, sessionId, requestId, decision, payload));
}
