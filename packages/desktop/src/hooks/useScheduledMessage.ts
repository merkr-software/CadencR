/**
 * Reads and mutates the single pending scheduled message for a conversation.
 *
 * Scheduling is keyed on the feature (the conversation), not a session, so it
 * works even for a brand-new conversation that has not spawned a session yet.
 * It is server-side, so this hook is a thin wrapper over the generated CRUD
 * hooks: it never holds optimistic state (per the no-optimistic-updates rule)
 * and re-reads from the backend after each mutation. While a message is pending
 * it polls so the card clears itself once the scheduler fires (the row flips to
 * `sent` and the endpoint returns null).
 */
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetScheduledMessageQueryKey,
  useDeleteScheduledMessage,
  useGetScheduledMessage,
  useSetScheduledMessage,
  type ScheduledMessage,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

export interface UseScheduledMessageResult {
  scheduled: ScheduledMessage | null;
  isLoading: boolean;
  /** Create or replace the pending scheduled message. Rejects on failure. */
  schedule: (text: string, scheduledAt: Date) => Promise<void>;
  /** Cancel the pending scheduled message. Rejects on failure. */
  cancel: () => Promise<void>;
  isMutating: boolean;
}

export function useScheduledMessage(featureId: number | undefined): UseScheduledMessageResult {
  const queryClient = useQueryClient();
  const query = useGetScheduledMessage(featureId ?? 0, {
    query: {
      enabled: !!featureId,
      // Poll while a message is pending so the card clears itself once the
      // scheduler fires (the row flips to `sent` and the endpoint returns
      // null). Poll quickly around the deadline — the server scans every ~10s —
      // and relax when the target is far off.
      refetchInterval: (data: ScheduledMessage | null | undefined) => {
        if (!data) return false;
        const msUntilDue = new Date(data.scheduled_at).getTime() - Date.now();
        if (msUntilDue <= 30_000) return 3_000;
        if (msUntilDue <= 5 * 60_000) return 15_000;
        return 60_000;
      },
    },
  });
  const setMutation = useSetScheduledMessage();
  const deleteMutation = useDeleteScheduledMessage();

  const invalidate = useCallback(() => {
    if (!featureId) return;
    void queryClient.invalidateQueries({ queryKey: getGetScheduledMessageQueryKey(featureId) });
  }, [queryClient, featureId]);

  const schedule = useCallback(
    async (text: string, scheduledAt: Date): Promise<void> => {
      if (!featureId) return;
      try {
        await setMutation.mutateAsync({
          featureId,
          data: { text, scheduled_at: scheduledAt.toISOString() },
        });
        invalidate();
      } catch (error) {
        toast.error(`Could not schedule message: ${apiErrorMessage(error, "Unknown error")}`);
        throw error;
      }
    },
    [invalidate, featureId, setMutation],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (!featureId) return;
    try {
      await deleteMutation.mutateAsync({ featureId });
      invalidate();
    } catch (error) {
      toast.error(`Could not cancel scheduled message: ${apiErrorMessage(error, "Unknown error")}`);
      throw error;
    }
  }, [deleteMutation, invalidate, featureId]);

  // The endpoint only ever returns a pending row (or null once it fires).
  const scheduled = query.data ?? null;

  return useMemo(
    () => ({
      scheduled,
      isLoading: query.isLoading,
      schedule,
      cancel,
      isMutating: setMutation.isPending || deleteMutation.isPending,
    }),
    [cancel, deleteMutation.isPending, query.isLoading, schedule, scheduled, setMutation.isPending],
  );
}
