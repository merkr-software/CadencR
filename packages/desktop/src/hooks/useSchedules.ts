/**
 * Reads and mutates schedules.
 *
 * Scheduling is server-side, so this holds no optimistic state (per the
 * no-optimistic-updates rule): every mutation re-reads from the backend. It
 * polls too, because a schedule firing changes the row without any client
 * action — the poll interval tightens as the soonest run approaches so the list
 * clears itself promptly, then relaxes.
 */
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getListSchedulesQueryKey,
  useCreateSchedule,
  useDeleteSchedule,
  useListSchedules,
  useRunSchedule,
  useSetScheduleEnabled,
  useUpdateSchedule,
  type ListSchedulesParams,
  type SaveScheduleRequest,
  type Schedule,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { isActive } from "@/lib/schedules/status";

export interface UseSchedulesResult {
  schedules: Schedule[];
  isLoading: boolean;
  isMutating: boolean;
  save: (body: SaveScheduleRequest, id?: number) => Promise<Schedule>;
  remove: (id: number) => Promise<void>;
  setEnabled: (id: number, enabled: boolean) => Promise<void>;
  runNow: (id: number) => Promise<void>;
}

/** The server scans every ~10s, so polling faster than that near a deadline can
 *  only re-read the same row; far from one, once a minute is plenty. */
function pollInterval(schedules: Schedule[] | undefined): number | false {
  if (!schedules?.length) return false;
  const upcoming = schedules
    .filter(isActive)
    .map((schedule) => new Date(schedule.next_run_at as string).getTime() - Date.now())
    // Overdue rows sit here for up to a full dispatcher tick, and indefinitely
    // if the service is wedged. Left negative they'd pin the app to the tightest
    // interval forever, so they wait at the scan cadence like anything else.
    .map((remaining) => Math.max(remaining, 0));
  if (!upcoming.length) return false;
  const soonest = Math.min(...upcoming);
  if (soonest <= 30_000) return 10_000;
  if (soonest <= 5 * 60_000) return 15_000;
  return 60_000;
}

/** The read half, for surfaces that only display schedules (a count, a banner)
 *  and would otherwise pay for five mutation hooks they never call. */
export function useScheduleList(params: ListSchedulesParams = {}): {
  schedules: Schedule[];
  isLoading: boolean;
} {
  // Referentially stable across renders so the query key (and therefore the
  // cache entry shared with every other consumer) doesn't churn.
  const key = useMemo(
    () => ({ feature_id: params.feature_id, project_id: params.project_id }),
    [params.feature_id, params.project_id],
  );
  const query = useListSchedules(key, {
    query: { refetchInterval: (data: Schedule[] | undefined) => pollInterval(data) },
  });
  return useMemo(
    () => ({
      schedules: Array.isArray(query.data) ? query.data : [],
      isLoading: query.isLoading,
    }),
    [query.data, query.isLoading],
  );
}

/** Every mutation shares this shape: run it, refresh every list variant, and
 *  surface a failure as a toast rather than a silent no-op. */
async function run<T>(action: string, invalidate: () => void, call: () => Promise<T>): Promise<T> {
  try {
    const result = await call();
    invalidate();
    return result;
  } catch (error) {
    toast.error(`Could not ${action}: ${apiErrorMessage(error, "Unknown error")}`);
    throw error;
  }
}

/** The write half: every mutation, each re-reading the list on success. */
function useScheduleMutations(): Omit<UseSchedulesResult, "schedules" | "isLoading"> {
  const queryClient = useQueryClient();

  const createMutation = useCreateSchedule();
  const updateMutation = useUpdateSchedule();
  const deleteMutation = useDeleteSchedule();
  const enabledMutation = useSetScheduleEnabled();
  const runMutation = useRunSchedule();

  // Every list variant (all schedules, per-conversation, per-project) shows the
  // same rows, so a change to one has to refresh them all. The param-less key
  // is the shared prefix react-query matches them by.
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
  }, [queryClient]);

  const save = useCallback(
    (body: SaveScheduleRequest, id?: number): Promise<Schedule> =>
      run("save the schedule", invalidate, () =>
        id
          ? updateMutation.mutateAsync({ id, data: body })
          : createMutation.mutateAsync({ data: body }),
      ),
    [createMutation, invalidate, updateMutation],
  );

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await run("delete the schedule", invalidate, () => deleteMutation.mutateAsync({ id }));
    },
    [deleteMutation, invalidate],
  );

  const setEnabled = useCallback(
    async (id: number, enabled: boolean): Promise<void> => {
      await run(`${enabled ? "resume" : "pause"} the schedule`, invalidate, () =>
        enabledMutation.mutateAsync({ id, data: { enabled } }),
      );
    },
    [enabledMutation, invalidate],
  );

  // A manual run reports its own failure in the response body rather than an
  // HTTP error (the schedule itself is fine — this attempt wasn't), so the
  // success path has to check it too.
  const runNow = useCallback(
    async (id: number): Promise<void> => {
      const result = await run("run the schedule", invalidate, () =>
        runMutation.mutateAsync({ id }),
      );
      if (result.ran) {
        toast.success("Schedule sent.");
      } else {
        toast.error(`The schedule could not run: ${result.error ?? "Unknown error"}`);
      }
    },
    [invalidate, runMutation],
  );

  return useMemo(
    () => ({
      isMutating:
        createMutation.isPending ||
        updateMutation.isPending ||
        deleteMutation.isPending ||
        enabledMutation.isPending ||
        runMutation.isPending,
      save,
      remove,
      setEnabled,
      runNow,
    }),
    [
      createMutation.isPending,
      deleteMutation.isPending,
      enabledMutation.isPending,
      remove,
      runMutation.isPending,
      runNow,
      save,
      setEnabled,
      updateMutation.isPending,
    ],
  );
}

export function useSchedules(params: ListSchedulesParams = {}): UseSchedulesResult {
  const { schedules, isLoading } = useScheduleList(params);
  const mutations = useScheduleMutations();
  return useMemo(() => ({ schedules, isLoading, ...mutations }), [isLoading, mutations, schedules]);
}
