import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
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
    queryFn: ({ signal }) => fetchOpenGate(featureId, signal),
    enabled: enabled && sample === null,
    retry: false,
    // A request id names one immutable request: rows remounting (scroll,
    // expand) reuse its payload. Without an id, or while no gate is open yet
    // (a restart clears it until the resumed turn raises it again), always
    // ask again.
    staleTime: ({ state }) => (liveRequestId && state.data ? Infinity : 0),
    // Pending gates are driven by WS status; window focus refetch is wasteful.
    refetchOnWindowFocus: false,
    // Drop unused payloads quickly — request ids rotate often.
    gcTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (decision: FeatureGateDecision) => {
      const requestId = query.data?.request_id;
      if (!requestId) {
        return Promise.reject(
          new Error(translateUi("sidebar.gate.noGate", "No pending gate to answer")),
        );
      }
      if (liveRequestId && requestId !== liveRequestId) {
        return Promise.reject(
          new Error(
            translateUi("sidebar.gate.changedGate", "Pending gate changed — refresh and try again"),
          ),
        );
      }
      return respondGate(featureId, { request_id: requestId, decision });
    },
    onError: (error: unknown) => {
      toast.error(
        apiErrorMessage(
          error,
          translateUi("sidebar.gate.answerFailed", "Could not answer pending request"),
        ),
      );
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

  const { t } = useUiTranslation();
  const respond = mutation.mutate;
  const isSubmitting = mutation.isPending;
  const data = query.data ?? undefined;
  const gate =
    data && (liveRequestId == null || data.request_id === liveRequestId) ? data : undefined;

  const live = useMemo(
    () => ({
      gate,
      isLoading: query.isLoading,
      isError: query.isError && gate == null,
      errorMessage:
        query.isError && gate == null
          ? apiErrorMessage(
              query.error,
              t("sidebar.gate.loadFailed", "Could not load pending request"),
            )
          : null,
      isSubmitting,
      respond,
    }),
    [gate, isSubmitting, query.error, query.isError, query.isLoading, respond, t],
  );
  const sampled = useMemo(() => sample && sampleGate(sample, featureId), [sample, featureId]);
  return sampled ?? live;
}

/**
 * The feature's open gate, or null when none is open: the service answers
 * that with 404 (its documented contract), an ordinary answer here rather
 * than a failure to show. It happens while a restart continuation re-raises
 * the gate a row still shows, or right after the gate was answered.
 */
async function fetchOpenGate(
  featureId: number,
  signal: AbortSignal,
): Promise<FeaturePendingGateResponse | null> {
  try {
    return await getPendingGate(featureId, signal);
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
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
