import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useCreateFeature } from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { navigateToConversation } from "@/lib/conversation-route";
import { invalidateFeatureLists } from "@/lib/featureUpdated";

export interface StartConversation {
  /** Creates a conversation in the project, then opens it. */
  start: (projectId: number) => void;
  isPending: boolean;
}

/**
 * The sidebar's "+" on a project: create a conversation there and open it.
 * Shared with the phone's empty home, so both open the same way.
 */
export function useStartConversation(): StartConversation {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutate, isPending } = useCreateFeature({
    mutation: {
      onSuccess: (session, variables) => {
        const projectId = variables.data.project_id;
        void invalidateFeatureLists(queryClient, projectId);
        navigateToConversation(navigate, projectId, session.id, { featureKnown: true });
      },
      onError: (error) => toastError(error, "Failed to create conversation"),
    },
  });
  const start = useCallback(
    (projectId: number): void => mutate({ data: { project_id: projectId, type: "ws-session" } }),
    [mutate],
  );
  return useMemo(() => ({ start, isPending }), [isPending, start]);
}
