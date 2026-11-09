import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetWorkspaceSetting } from "@/api/generated";
import {
  isSettingSaving,
  subscribeSettingWrites,
  writeSetting,
  type SettingUpdate,
} from "./setting-persistence";

export interface SettingWriter {
  /**
   * Persists a value, or one computed from the confirmed value when the write
   * goes out. Resolves true once the backend holds it, false after a failed
   * write (already toasted). Never rejects.
   */
  setValue: (next: string | SettingUpdate) => Promise<boolean>;
  /** A write to this key is queued or on its way. */
  isSaving: boolean;
}

export interface Setting extends SettingWriter {
  /** The value the backend confirmed, or null if unset. */
  value: string | null;
  isLoading: boolean;
  /**
   * True once a fetch settled (successfully or not). Unlike `!isLoading`, it is
   * false on the very first render, before the query has started fetching.
   */
  isFetched: boolean;
}

/** Writes one workspace setting through {@link writeSetting}, for callers that read it elsewhere. */
export function useSettingWriter(key: string): SettingWriter {
  const queryClient = useQueryClient();
  const isSaving = useSyncExternalStore(
    subscribeSettingWrites,
    () => isSettingSaving(key),
    () => isSettingSaving(key),
  );
  const setValue = useCallback(
    (next: string | SettingUpdate) => writeSetting(queryClient, key, next),
    [key, queryClient],
  );
  return useMemo(() => ({ setValue, isSaving }), [setValue, isSaving]);
}

/**
 * A workspace setting as the backend confirmed it, and its writer. The value
 * changes only once a write is confirmed; a control that must follow a gesture
 * before then uses `useSettingDraft`.
 */
export function useSetting(key: string): Setting {
  const query = useGetWorkspaceSetting(key);
  const { setValue, isSaving } = useSettingWriter(key);
  const value = query.data?.value ?? null;
  const { isLoading, isFetched } = query;
  return useMemo(
    () => ({ value, setValue, isLoading, isFetched, isSaving }),
    [value, setValue, isLoading, isFetched, isSaving],
  );
}
