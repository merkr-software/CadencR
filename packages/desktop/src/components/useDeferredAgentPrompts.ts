import { useCallback, useMemo, useState } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { PendingPlanApproval } from "@/stores/ws-session-types";
import type { PendingPermission } from "@/types/agent-permission";
import type { AgentQuestion } from "@/types/agent-question";

const PROMPT_TYPING_IDLE_MS = 1000;

interface UseDeferredAgentPromptsArgs {
  pendingPermission?: PendingPermission | null;
  pendingPlanApproval?: PendingPlanApproval | null;
  /**
   * The pending question. Its identity names the request: the store makes a
   * new list for each question and keeps it while that one waits, including
   * when a reconnect re-sends it (`handlePermissionRequest`).
   */
  pendingQuestions?: AgentQuestion[];
  promptText: string;
}

interface DeferredAgentPromptsState {
  visiblePermission: PendingPermission | null;
  visiblePlanApproval: PendingPlanApproval | null;
  visibleQuestions: AgentQuestion[] | undefined;
  permissionDeferred: boolean;
  planApprovalDeferred: boolean;
  questionsDeferred: boolean;
  /** The user put the pending permission off ("Later"): the composer shows meanwhile. */
  permissionLater: boolean;
  /** The user put the pending question off ("Later"): the composer shows meanwhile. */
  questionsLater: boolean;
  /** Folds the pending permission away without answering it. */
  putPermissionOff: () => void;
  /** Folds the pending question away without answering it. */
  putQuestionOff: () => void;
  /** Shows the permission put off again. */
  reopenPermission: () => void;
  /** Shows the question put off again. */
  reopenQuestion: () => void;
}

/** Per gate, the request the user put off: a key for a permission, the list for a question. */
interface GateLaterSlots {
  permission: string | null;
  question: AgentQuestion[] | null;
}

const NO_GATE_PUT_OFF: GateLaterSlots = { permission: null, question: null };

function permissionKey(permission: PendingPermission | null | undefined): string | null {
  if (!permission) return null;
  return `permission:${permission.requestId ?? `${permission.toolName}:${permission.pattern}`}`;
}

/**
 * Which pending permission and question the user put off ("Later" on a phone
 * gate), each in its own slot since both can wait at once: only that request
 * stays folded, and its slot empties once it is answered or replaced, so the
 * next one shows on its own even under the same fallback key. Nothing reaches
 * the backend: the agent keeps waiting for its answer.
 */
function useGateLater(permission: string | null, question: AgentQuestion[] | null) {
  const [stored, setStored] = useState<GateLaterSlots>(NO_GATE_PUT_OFF);
  // Freed during render, so a stale slot never hides the next request for a frame.
  const stalePermission = stored.permission !== null && stored.permission !== permission;
  const staleQuestion = stored.question !== null && stored.question !== question;
  if (stalePermission || staleQuestion) {
    setStored({
      permission: stalePermission ? null : stored.permission,
      question: staleQuestion ? null : stored.question,
    });
  }
  const putPermissionOff = useCallback(
    () => setStored((prev) => ({ ...prev, permission })),
    [permission],
  );
  const putQuestionOff = useCallback(
    () => setStored((prev) => ({ ...prev, question })),
    [question],
  );
  const reopenPermission = useCallback(
    () => setStored((prev) => ({ ...prev, permission: null })),
    [],
  );
  const reopenQuestion = useCallback(() => setStored((prev) => ({ ...prev, question: null })), []);
  return {
    permissionLater: permission !== null && stored.permission === permission,
    questionsLater: question !== null && stored.question === question,
    putPermissionOff,
    putQuestionOff,
    reopenPermission,
    reopenQuestion,
  };
}

/**
 * Single source of truth for "the user is currently typing into the prompt
 * bar, hide special prompts so they don't steal Enter / cmd+Y". One debounced
 * comparison drives all three flags so the UX stays in lockstep across
 * permission / plan-approval / question prompts. A permission or question the
 * user put off ("Later") stays hidden the same way until reopened.
 */
export function useDeferredAgentPrompts({
  pendingPermission,
  pendingPlanApproval,
  pendingQuestions,
  promptText,
}: UseDeferredAgentPromptsArgs): DeferredAgentPromptsState {
  const debouncedPromptText = useDebouncedValue(promptText, PROMPT_TYPING_IDLE_MS);
  const isTyping = promptText !== debouncedPromptText;

  const hasQuestions = !!pendingQuestions?.length;
  const {
    permissionLater,
    questionsLater,
    putPermissionOff,
    putQuestionOff,
    reopenPermission,
    reopenQuestion,
  } = useGateLater(
    permissionKey(pendingPermission),
    pendingQuestions?.length ? pendingQuestions : null,
  );

  const permissionDeferred = !!pendingPermission && isTyping && !permissionLater;
  const planApprovalDeferred = !!pendingPlanApproval && isTyping;
  const questionsDeferred = hasQuestions && isTyping && !questionsLater;

  const permissionHidden = permissionDeferred || permissionLater;
  const visiblePermission = permissionHidden ? null : (pendingPermission ?? null);
  const visiblePlanApproval = planApprovalDeferred ? null : (pendingPlanApproval ?? null);
  const visibleQuestions = questionsDeferred || questionsLater ? undefined : pendingQuestions;

  return useMemo(
    () => ({
      visiblePermission,
      visiblePlanApproval,
      visibleQuestions,
      permissionDeferred,
      planApprovalDeferred,
      questionsDeferred,
      permissionLater,
      questionsLater,
      putPermissionOff,
      putQuestionOff,
      reopenPermission,
      reopenQuestion,
    }),
    [
      visiblePermission,
      visiblePlanApproval,
      visibleQuestions,
      permissionDeferred,
      planApprovalDeferred,
      questionsDeferred,
      permissionLater,
      questionsLater,
      putPermissionOff,
      putQuestionOff,
      reopenPermission,
      reopenQuestion,
    ],
  );
}
