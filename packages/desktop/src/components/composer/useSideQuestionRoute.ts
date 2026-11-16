import { useCallback } from "react";
import { toast } from "sonner";
import { type SideQuestionRequest, useAskSessionSideQuestion } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { parseSideQuestion, SIDE_QUESTION_SKILL } from "@/lib/side-question-skill";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { useSideConversationStore } from "@/stores/side-conversation-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { SendFn } from "../agent-prompt-send";

/**
 * Chip choices the service has not saved: until the session joins (an
 * embedded card joins only to send), a mode change lives only here. Without
 * one, or once joined, the side follows the source's saved row.
 */
function unsavedModes(
  featureId: number | undefined,
): Pick<SideQuestionRequest, "permission_mode" | "access_mode"> {
  if (featureId == null) return {};
  const session = useWsSessionStore.getState().sessions[wsSessionIdFromFeature(featureId)];
  if (!session || session.serverSessionId) return {};
  return {
    permission_mode: session.pendingInitPermissionMode,
    access_mode: session.pendingInitAccessMode,
  };
}

/**
 * Routes a `/cadencr:side <question>` prompt away from the agent: the question
 * goes to a new conversation in the same working directory and permission
 * mode, seeded with this one's recent messages, and this agent is neither
 * interrupted nor shown it. The service keeps that conversation archived
 * (temporary); it answers in a panel atop this composer (`SideConversations`)
 * until the user keeps it as a thread. Any other prompt goes through `send`
 * untouched. A refused question throws after its toast, so the send runner
 * restores the draft.
 */
export function useSideQuestionRoute(sessionId: number | undefined, featureId?: number) {
  const { mutateAsync } = useAskSessionSideQuestion();
  return useCallback(
    (send: SendFn): SendFn =>
      async (text, attachments) => {
        const question = parseSideQuestion(text);
        if (question === null || sessionId == null) return send(text, attachments);
        const refusal = !question
          ? `Type your question after /${SIDE_QUESTION_SKILL.name}.`
          : attachments?.length
            ? "Images can't go to a side question. Remove them, or send them to the agent."
            : null;
        if (refusal) {
          toast.error(refusal);
          throw new Error(refusal);
        }
        try {
          const result = await mutateAsync({
            sessionId,
            data: { question, ...unsavedModes(featureId) },
          });
          useSideConversationStore.getState().add(sessionId, {
            featureId: result.feature_id,
            sessionId: result.session_id,
            projectId: result.project_id,
            question,
          });
        } catch (error) {
          toast.error(apiErrorMessage(error, "Couldn't start the side conversation"));
          throw error;
        }
      },
    [featureId, mutateAsync, sessionId],
  );
}
