/**
 * Reads and mutates schedules.
 *
 * Scheduling is server-side, so this holds no optimistic state (per the
 * no-optimistic-updates rule): every mutation re-reads from the backend. A
 * schedule firing changes the row without any client action, and the server
 * says so directly — `app/schedule_event`, handled in
 * `session-status-handlers.ts`. The slow poll below is only the fallback for
 * when that socket is down.
 */
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
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
import { invalidateScheduleLists } from "@/lib/schedules/invalidate";
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

/**
 * Safety net, not the mechanism.
 *
 * A run reaches us as a push, so this exists only to close the window where
 * that socket is down. It replaced a ramp that tightened to 10s near a
 * deadline: `SchedulesSidebarLink` is mounted app-wide, so that was a request
 * every ten seconds, forever, for anyone holding an upcoming schedule.
 *
 * Still gated on having something armed — a list of finished rules can't change
 * on its own. `Array.isArray` rather than a truthiness check, matching how
 * `useScheduleList` reads the same cache entry: react-query hands this whatever
 * is cached, which isn't guaranteed to be the list yet.
 */
function pollInterval(schedules: Schedule[] | undefined): number | false {
  return Array.isArray(schedules) && schedules.some(isActive) ? 60_000 : false;
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

/**
 * Fire a mutation from an event handler that has nothing to do with the result.
 *
 * The mutations below rethrow so callers that *do* care (the editor dialog,
 * which stays open on failure) can await them. A `void`-ed call would leave that
 * rejection unhandled — console noise in the app, a failed run in Vitest — even
 * though `run` has already shown the user the toast. This consumes it, and only
 * it: the reporting has already happened, so nothing is being swallowed.
 */
export function fireAndForget(promise: Promise<unknown>): void {
  void promise.catch(() => {});
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

  // Shared with the `schedule_event` push handler, so a "Run now" click and the
  // broadcast it triggers collapse into one refetch instead of racing.
  const invalidate = useCallback(() => {
    invalidateScheduleLists(queryClient);
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
