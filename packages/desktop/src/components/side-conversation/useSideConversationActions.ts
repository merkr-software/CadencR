import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useUpdateFeatureStatus } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useSideConversationStore, type SideConversation } from "@/stores/side-conversation-store";

/**
 * What the user can do with a side question: keep it as a real thread (it
 * leaves the archive, so the sidebar lists it, and opens), or close it (it
 * stays archived; a live side agent — working, or waiting at a gate — is
 * stopped first, so nothing keeps running unseen).
 */
export function useSideConversationActions(
  sourceSessionId: number,
  conversation: SideConversation,
  live: boolean,
) {
  const navigate = useNavigate();
  const { mutateAsync, isPending: keeping } = useUpdateFeatureStatus();
  const { featureId, projectId } = conversation;
  const keep = useCallback(async (): Promise<void> => {
    try {
      await mutateAsync({ id: featureId, data: { status: "active" } });
    } catch (error) {
      toast.error(apiErrorMessage(error, "Couldn't keep the side question as a thread"));
      return;
    }
    void invalidateByUrlPrefix(queryClient, "/api/features");
    useSideConversationStore.getState().remove(sourceSessionId, featureId);
    navigateToFeatureIdOrHome(navigate, projectId, featureId);
  }, [featureId, mutateAsync, navigate, projectId, sourceSessionId]);
  const close = useCallback((): void => {
    if (live) useWsSessionStore.getState().interrupt(wsSessionIdFromFeature(featureId));
    useSideConversationStore.getState().remove(sourceSessionId, featureId);
  }, [featureId, live, sourceSessionId]);
  return useMemo(() => ({ keep, keeping, close }), [close, keep, keeping]);
}
