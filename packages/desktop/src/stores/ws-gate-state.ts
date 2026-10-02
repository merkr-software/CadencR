import type { SessionEntry } from "./ws-session-types";

const GATE_CLOSING_ERROR_CODES: ReadonlySet<string> = new Set([
  "SESSION_NOT_FOUND",
  "INVALID_STATE",
  "CHANNEL_ERROR",
  "RUNTIME_PERMISSION_ERROR",
]);

export function isGateClosingErrorCode(code: string | undefined): boolean {
  return code != null && GATE_CLOSING_ERROR_CODES.has(code);
}

/** Whether the session is waiting on a user gate (permission / question / plan). */
export function hasOpenGate(session: SessionEntry): boolean {
  return (
    session.pendingPermission != null ||
    session.pendingPermissionQueue.length > 0 ||
    session.pendingQuestions.length > 0 ||
    session.pendingPlanApproval != null
  );
}

export function buildClearedGatePatch(session: SessionEntry): Partial<SessionEntry> | null {
  const hasGateState =
    session.pendingPermission != null ||
    session.pendingPermissionQueue.length > 0 ||
    session.pendingRequestId !== "" ||
    session.submittingPermissionRequestId != null ||
    session.pendingQuestions.length > 0 ||
    Object.keys(session.pendingQuestionToolInput).length > 0 ||
    session.pendingPlanApproval != null;
  if (!hasGateState) return null;
  return {
    pendingPermission: null,
    pendingPermissionQueue: [],
    pendingRequestId: "",
    submittingPermissionRequestId: null,
    pendingQuestions: [],
    pendingQuestionToolInput: {},
    pendingPlanApproval: null,
  };
}
