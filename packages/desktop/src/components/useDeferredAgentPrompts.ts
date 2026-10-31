import { useMemo } from "react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { PendingPlanApproval } from "@/stores/ws-session-types";
import type { PendingPermission } from "@/types/agent-permission";
import type { AgentQuestion } from "@/types/agent-question";

const PROMPT_TYPING_IDLE_MS = 1000;

interface UseDeferredAgentPromptsArgs {
  pendingPermission?: PendingPermission | null;
  pendingPlanApproval?: PendingPlanApproval | null;
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
}

/**
 * Single source of truth for "the user is currently typing into the prompt
 * bar, hide special prompts so they don't steal Enter / cmd+Y". One debounced
 * comparison drives all three flags so the UX stays in lockstep across
 * permission / plan-approval / question prompts.
 */
export function useDeferredAgentPrompts({
  pendingPermission,
  pendingPlanApproval,
  pendingQuestions,
  promptText,
}: UseDeferredAgentPromptsArgs): DeferredAgentPromptsState {
  const debouncedPromptText = useDebouncedValue(promptText, PROMPT_TYPING_IDLE_MS);
  const isTyping = promptText !== debouncedPromptText;

  const permissionDeferred = !!pendingPermission && isTyping;
  const planApprovalDeferred = !!pendingPlanApproval && isTyping;
  const questionsDeferred = !!(pendingQuestions && pendingQuestions.length > 0) && isTyping;

  const visiblePermission = permissionDeferred ? null : (pendingPermission ?? null);
  const visiblePlanApproval = planApprovalDeferred ? null : (pendingPlanApproval ?? null);
  const visibleQuestions = questionsDeferred ? undefined : pendingQuestions;

  return useMemo(
    () => ({
      visiblePermission,
      visiblePlanApproval,
      visibleQuestions,
      permissionDeferred,
      planApprovalDeferred,
      questionsDeferred,
    }),
    [
      visiblePermission,
      visiblePlanApproval,
      visibleQuestions,
      permissionDeferred,
      planApprovalDeferred,
      questionsDeferred,
    ],
  );
}
