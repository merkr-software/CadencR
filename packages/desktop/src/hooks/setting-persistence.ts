import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetWorkspaceSettingQueryKey,
  setWorkspaceSetting,
  type SettingValueResponse,
} from "@/api/generated";
import { getWorkspaceSettingsQueryKey, type SettingEntry } from "@/api/settings";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Computes the value to write from the setting's confirmed value at the moment
 * the write goes out (undefined while it has never loaded). Returning null
 * writes nothing.
 */
export type SettingUpdate = (confirmed: string | null | undefined) => string | null;

// Writes to one key go out one at a time, so the backend and the cache see them
// in the order they were made. Per QueryClient, without retaining any.
const queues = new WeakMap<QueryClient, Map<string, Promise<boolean>>>();
const inFlight = new Map<string, number>();
const listeners = new Set<() => void>();

/**
 * The single write path for workspace settings. The cache only moves to the
 * value the backend answered with (no optimistic updates); a failure toasts,
 * leaves the confirmed value in place and re-reads it, in case the write landed
 * before the failure. Resolves true when the backend holds the value (or there
 * was nothing to write), false when the write failed. Never rejects.
 */
export function writeSetting(
  queryClient: QueryClient,
  key: string,
  next: string | SettingUpdate,
): Promise<boolean> {
  let queue = queues.get(queryClient);
  if (!queue) {
    queue = new Map();
    queues.set(queryClient, queue);
  }
  const previous = queue.get(key) ?? Promise.resolve(true);
  changeInFlight(key, 1);
  const task = previous
    .then(() => sendSetting(queryClient, key, next))
    .finally(() => changeInFlight(key, -1));
  queue.set(key, task);
  void task.then(() => {
    if (queue.get(key) === task) queue.delete(key);
  });
  return task;
}

async function sendSetting(
  queryClient: QueryClient,
  key: string,
  next: string | SettingUpdate,
): Promise<boolean> {
  try {
    const value = typeof next === "string" ? next : next(readConfirmedSetting(queryClient, key));
    if (value === null) return true;
    const saved = await setWorkspaceSetting(key, { value });
    seedConfirmedSetting(queryClient, key, saved.value ?? null);
    return true;
  } catch (error: unknown) {
    toast.error(`Could not save setting "${key}": ${apiErrorMessage(error, "Unknown error")}`);
    // Not awaited: callers fall back to the confirmed value at once; a failed
    // refetch leaves that value in place and shows on the query itself.
    void queryClient.invalidateQueries({ queryKey: getGetWorkspaceSettingQueryKey(key) });
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
