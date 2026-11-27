import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import {
  getGetWorkspaceSettingQueryKey,
  getWorkspaceSetting,
  setWorkspaceSetting,
  type SettingValueResponse,
} from "@/api/generated";
import { getWorkspaceSettingsQueryKey, type SettingEntry } from "@/api/settings";
import { apiErrorMessage } from "@/lib/api-errors";

const settingValueResponseSchema: z.ZodType<SettingValueResponse> = z.object({
  value: z.string().nullable().optional(),
});

function parseSettingResponse(response: unknown): SettingValueResponse {
  const parsed = settingValueResponseSchema.safeParse(response);
  if (!parsed.success) throw new Error("Invalid workspace setting response");
  return parsed.data;
}

export async function fetchWorkspaceSetting(
  key: string,
  signal?: AbortSignal,
): Promise<SettingValueResponse> {
  return parseSettingResponse(await getWorkspaceSetting(key, signal));
}

/**
 * Computes the value to write from the setting's confirmed value at the moment
 * the write goes out (undefined while it has never loaded). Returning null
 * writes nothing.
 */
export type SettingUpdate = (confirmed: string | null | undefined) => string | null;

interface SettingQueue {
  /** The last write queued for a key, so the next one waits for it. */
  writes: Map<string, Promise<boolean>>;
  /**
   * Keys whose last write failed without a confirmed outcome: the cached value
   * may predate a write the backend committed, so no update may merge into it
   * until a read succeeds.
   */
  unreconciled: Set<string>;
}

// Writes to one key go out one at a time, so the backend and the cache see them
// in the order they were made. Per QueryClient, without retaining any.
const queues = new WeakMap<QueryClient, SettingQueue>();
const inFlight = new Map<string, number>();
const listeners = new Set<() => void>();

function queueFor(queryClient: QueryClient): SettingQueue {
  let queue = queues.get(queryClient);
  if (!queue) {
    queue = { writes: new Map(), unreconciled: new Set() };
    queues.set(queryClient, queue);
  }
  return queue;
}

/**
 * The single write path for workspace settings. The cache only moves to the
 * value the backend answered with (no optimistic updates); a failure toasts,
 * leaves the confirmed value in place and re-reads it, in case the write landed
 * before the failure. The next write to that key waits for that re-read and
 * does not go out if it failed. Resolves true when the backend holds the value
 * (or there was nothing to write), false when the write failed. Never rejects.
 */
export function writeSetting(
  queryClient: QueryClient,
  key: string,
  next: string | SettingUpdate,
): Promise<boolean> {
  const queue = queueFor(queryClient);
  const previous = queue.writes.get(key) ?? Promise.resolve(true);
  changeInFlight(key, 1);
  const task = previous
    .then(() => sendSetting(queryClient, key, next, queue))
    .finally(() => changeInFlight(key, -1));
  queue.writes.set(key, task);
  void task.then(() => {
    if (queue.writes.get(key) === task) queue.writes.delete(key);
  });
  return task;
}

async function sendSetting(
  queryClient: QueryClient,
  key: string,
  next: string | SettingUpdate,
  queue: SettingQueue,
): Promise<boolean> {
  if (queue.unreconciled.has(key) && !(await reconcileConfirmedSetting(queryClient, key))) {
    return false;
  }
  queue.unreconciled.delete(key);
  try {
    const value = typeof next === "string" ? next : next(readConfirmedSetting(queryClient, key));
    if (value === null) return true;
    const saved = parseSettingResponse(await setWorkspaceSetting(key, { value }));
    // A read begun before the write could replace its confirmed value.
    await queryClient.cancelQueries({ queryKey: getGetWorkspaceSettingQueryKey(key), exact: true });
    seedConfirmedSetting(queryClient, key, saved.value ?? null);
    return true;
  } catch (error: unknown) {
    toast.error(`Could not save setting "${key}": ${apiErrorMessage(error, "Unknown error")}`);
    queue.unreconciled.add(key);
    // Awaited: the next write must not merge into a value that may predate this
    // one. A failed read leaves the key unreconciled, so the next write reads
    // again before it sends anything.
    if (await reconcileConfirmedSetting(queryClient, key)) queue.unreconciled.delete(key);
    return false;
  }
}

/**
 * Re-reads the confirmed value after a write whose outcome is unknown, so the
 * next update cannot merge into a value that predates it. Resolves false when
 * the read failed, leaving the key unreconciled.
 */
async function reconcileConfirmedSetting(queryClient: QueryClient, key: string): Promise<boolean> {
  const queryKey = getGetWorkspaceSettingQueryKey(key);
  try {
    // A read already in flight may have captured the value before the write.
    await queryClient.cancelQueries({ queryKey, exact: true });
    const fresh = await queryClient.fetchQuery({
      queryKey,
      // The queue needs this read even if the last settings observer unmounts.
      queryFn: ({ signal }) => fetchWorkspaceSetting(key, signal),
      staleTime: 0,
      retry: false,
      networkMode: "always",
    });
    seedConfirmedSetting(queryClient, key, fresh.value ?? null);
    return true;
  } catch (error: unknown) {
    toast.error(
      `Could not reload setting "${key}" after a failed save: ${apiErrorMessage(error, "Unknown error")}`,
    );
    return false;
  }
}

/** The value the backend last confirmed for `key`, from either settings cache. */
export function readConfirmedSetting(
  queryClient: QueryClient,
  key: string,
): string | null | undefined {
  const single = queryClient.getQueryData<SettingValueResponse>(
    getGetWorkspaceSettingQueryKey(key),
  );
  if (single !== undefined) return single.value ?? null;
  const bulk = queryClient.getQueryData<SettingEntry[]>(getWorkspaceSettingsQueryKey());
  if (bulk === undefined) return undefined;
  return bulk.find((entry) => entry.key === key)?.value ?? null;
}

/**
 * Puts a value the backend confirmed (null: cleared) in both settings caches:
 * the per-key query and the bulk list that `useGetWorkspaceSettings` readers
 * (theme, favorite models) use.
 */
export function seedConfirmedSetting(
  queryClient: QueryClient,
  key: string,
  value: string | null,
): void {
  queryClient.setQueryData<SettingValueResponse>(getGetWorkspaceSettingQueryKey(key), { value });
  queryClient.setQueryData<SettingEntry[]>(getWorkspaceSettingsQueryKey(), (entries) => {
    if (entries === undefined) return entries;
    const others = entries.filter((entry) => entry.key !== key);
    return value === null ? others : [...others, { key, value }];
  });
}

/** Whether a write to `key` is queued or on its way, from any component. */
export function isSettingSaving(key: string): boolean {
  return (inFlight.get(key) ?? 0) > 0;
}

export function subscribeSettingWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changeInFlight(key: string, delta: number): void {
  const count = (inFlight.get(key) ?? 0) + delta;
  if (count > 0) inFlight.set(key, count);
  else inFlight.delete(key);
  for (const listener of listeners) listener();
}
