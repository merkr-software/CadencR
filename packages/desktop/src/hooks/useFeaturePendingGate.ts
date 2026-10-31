import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  getPendingGate,
  respondGate,
  type FeatureGateDecision,
  type FeaturePendingGateResponse,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import { useSidebarSample, type SidebarSampleData } from "@/lib/sidebar-sample-context";
import { useFeaturePendingRequestId } from "@/stores/pending-gate-popover-selectors";
import { toast } from "sonner";

interface UseFeaturePendingGateOptions {
  featureId: number;
  /** Fetch only when shown: the open popover or the row's request line. */
  enabled: boolean;
}

interface UseFeaturePendingGateResult {
  gate: FeaturePendingGateResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  isSubmitting: boolean;
  respond: (decision: FeatureGateDecision) => void;
}

export function useFeaturePendingGate({
  featureId,
  enabled,
}: UseFeaturePendingGateOptions): UseFeaturePendingGateResult {
  // Include the live request id so a question→question transition (stacked /
  // sequential gates) cannot keep serving the previous gate's cached payload.
  const liveRequestId = useFeaturePendingRequestId(featureId);
  const sample = useSidebarSample();

  const query = useQuery({
    queryKey: ["/api/features", featureId, "pending-gate", liveRequestId ?? ""],
    queryFn: ({ signal }) => getPendingGate(featureId, signal),
    enabled: enabled && sample === null,
    retry: false,
    // A request id names one immutable request: rows remounting (scroll,
    // expand) reuse its payload. Without an id, always ask again.
    staleTime: liveRequestId ? Infinity : 0,
    // Pending gates are driven by WS status; window focus refetch is wasteful.
    refetchOnWindowFocus: false,
    // Drop unused payloads quickly — request ids rotate often.
    gcTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (decision: FeatureGateDecision) => {
      const requestId = query.data?.request_id;
      if (!requestId) {
        return Promise.reject(new Error("No pending gate to answer"));
      }
      if (liveRequestId && requestId !== liveRequestId) {
        return Promise.reject(new Error("Pending gate changed — refresh and try again"));
      }
      return respondGate(featureId, { request_id: requestId, decision });
    },
    onError: (error: unknown) => {
      toast.error(apiErrorMessage(error, "Could not answer pending request"));
    },
    onSuccess: async (response) => {
      for (const [index, warning] of (response.warnings ?? []).entries()) {
        toast.warning(warning, {
          id: `pending-gate-warning:${featureId}:${response.request_id}:${index}`,
        });
      }
      await queryClient.invalidateQueries({
        queryKey: ["/api/features", featureId, "pending-gate"],
      });
    },
  });

  const respond = mutation.mutate;
  const isSubmitting = mutation.isPending;
  const gateMatchesLive =
    query.data != null && (liveRequestId == null || query.data.request_id === liveRequestId);
  const gate = gateMatchesLive ? query.data : undefined;

  const live = useMemo(
    () => ({
      gate,
      isLoading: query.isLoading,
      isError: query.isError && gate == null,
      errorMessage:
        query.isError && gate == null
          ? apiErrorMessage(query.error, "Could not load pending request")
          : null,
      isSubmitting,
      respond,
    }),
    [gate, isSubmitting, query.error, query.isError, query.isLoading, respond],
  );
  const sampled = useMemo(() => sample && sampleGate(sample, featureId), [sample, featureId]);
  return sampled ?? live;
}

/** A display options preview sample: its request is local, answering it sends nothing. */
function sampleGate(sample: SidebarSampleData, featureId: number): UseFeaturePendingGateResult {
  return {
    gate: sample.gates.get(featureId),
    isLoading: false,
    isError: false,
    errorMessage: null,
    isSubmitting: false,
    respond: () => sample.respond(featureId),
  };
}
