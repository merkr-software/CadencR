import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetUnifiedAgentsQueryKey,
  useUpdateFeaturePinned,
  type UnifiedAgentEntry,
  type UnifiedAgentsResponse,
} from "@/api/generated";
import { urlPrefixPredicate } from "@/lib/queryClient";

interface UnifiedAgentPinControlOptions {
  showProgressToast?: boolean;
}

interface UnifiedAgentPinControls {
  isPending: boolean;
  toggle: () => void;
}

export function useUnifiedAgentPinControls(
  entry: UnifiedAgentEntry | null,
  options: UnifiedAgentPinControlOptions = {},
): UnifiedAgentPinControls {
  const queryClient = useQueryClient();
  // Pinning is feature-level (the conversation), so the grid's `is_pinned` is
  // shared by every card belonging to that feature. Patch the cached
  // unified-agents responses in place rather than invalidating: a refetch
  // re-runs `list_unified_agents`, which serially re-hydrates every active
  // agent's full transcript (an N+1 over `get_feature_agent_state`) — far too
  // expensive for a boolean toggle. Client-side sort/filter
  // (`UnifiedAgentsViewData`) reorders from the patched `is_pinned`. Applied on
  // mutation success, so this is a confirmed write, not an optimistic one. The
  // sidebar refreshes independently via the feature_event broadcast.
  const setPinnedInCache = useCallback(
    (featureId: number, isPinned: boolean): void => {
      const urlKey = getGetUnifiedAgentsQueryKey()[0];
      if (typeof urlKey !== "string") return;
      queryClient.setQueriesData<UnifiedAgentsResponse>(
        { predicate: urlPrefixPredicate(urlKey) },
        (data) => {
          // Return the same reference when this cached response holds no card
          // for the toggled feature — avoids re-rendering its subscribers.
          if (!data?.agents.some((agent) => agent.feature.id === featureId)) return data;
          return {
            ...data,
            agents: data.agents.map((agent) =>
              agent.feature.id === featureId ? { ...agent, is_pinned: isPinned } : agent,
            ),
          };
        },
      );
    },
    [queryClient],
  );
  const onError = useCallback((error: unknown): void => {
    const message = error instanceof Error ? error.message : "Failed to update pinned agent.";
    toast.error(message);
  }, []);
  const pinMutation = useUpdateFeaturePinned({
    mutation: {
      onSuccess: (_data, variables) => setPinnedInCache(variables.id, variables.data.pinned),
      onError,
    },
  });
  const mutate = pinMutation.mutate;
  const isPending = pinMutation.isPending;
  const toggle = useCallback((): void => {
    if (!entry || isPending) return;
    const toastId = showPinProgress(entry, options.showProgressToast === true);
    const callbacks = {
      onSettled: (): void => {
        if (toastId !== null) toast.dismiss(toastId);
      },
    };
    mutate({ id: entry.feature.id, data: { pinned: !entry.is_pinned } }, callbacks);
  }, [entry, isPending, options.showProgressToast, mutate]);
  return useMemo(() => ({ isPending, toggle }), [isPending, toggle]);
}

function showPinProgress(entry: UnifiedAgentEntry, enabled: boolean): string | number | null {
  if (!enabled) return null;
  return toast.loading(entry.is_pinned ? "Unpinning agent…" : "Pinning agent…");
}
