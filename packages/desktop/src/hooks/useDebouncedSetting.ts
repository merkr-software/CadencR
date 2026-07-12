import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWorkspaceSetting,
  useSetWorkspaceSetting,
  getGetWorkspaceSettingQueryKey,
  type SettingValueResponse,
} from "../api/generated";
import { getWorkspaceSettingsQueryKey, type SettingEntry } from "@/api/settings";
import { apiErrorMessage } from "@/lib/api-errors";

interface DebouncedSettingResult {
  value: string | null;
  setValue: (value: string) => void;
  isLoading: boolean;
}

/**
 * Returns a debounced setter that persists a value to the settings table,
 * plus the current persisted value (or null if not yet set).
 */
export function useDebouncedSetting(
  key: string,
  debounceMs = 300,
  { immediateCache = true } = {},
): DebouncedSettingResult {
  const query = useGetWorkspaceSetting(key);
  const { mutate } = useSetWorkspaceSetting();
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const setValue = useCallback(
    (value: string) => {
      const queryKey = getGetWorkspaceSettingQueryKey(key);
      const previousValue = queryClient.getQueryData<SettingValueResponse>(queryKey);

      // Update cache immediately so UI responds instantly (skip for continuous
      // updates like drag-resize where re-renders disrupt the interaction)
      if (immediateCache) {
        queryClient.setQueryData(queryKey, { value });
      }

      if (timerRef.current) clearTimeout(timerRef.current);

      const persistValue = (): void => {
        mutate(
          { key, data: { value } },
          {
            onSuccess: () => {
              if (!immediateCache) queryClient.setQueryData(queryKey, { value });
            },
            onError: (err: unknown) => {
              if (immediateCache) {
                if (previousValue === undefined) {
                  void queryClient.invalidateQueries({ queryKey });
                } else {
                  queryClient.setQueryData(queryKey, previousValue);
                }
              }
              const message = apiErrorMessage(err, "Unknown error");
              toast.error(`Could not save setting "${key}": ${message}`);
            },
          },
        );
      };

      if (debounceMs <= 0) {
        persistValue();
        return;
      }

      timerRef.current = setTimeout(persistValue, debounceMs);
    },
    [key, debounceMs, immediateCache, mutate, queryClient],
  );

  const value = query.data?.value ?? null;
  const isLoading = query.isLoading;
  return useMemo(() => ({ value, setValue, isLoading }), [value, setValue, isLoading]);
}

/**
 * Same shape as `useDebouncedSetting` but reads its value from a caller-owned
 * settings map (built once from `useGetWorkspaceSettings()` + `settingsArrayToMap`)
 * instead of firing its own `GET /api/workspace/settings/{key}` request.
 *
 * Use this when several settings keys are consumed together on the same screen
 * (e.g. theme keys in `useTheme`) so the cold-open waterfall collapses to a
 * single bulk fetch.
 *
 * Writers warm the bulk-cache (`getWorkspaceSettingsQueryKey()`) on success so
 * the next reader sees the new value without a refetch round-trip.
 */
export function useDebouncedSettingFromMap(
  map: Record<string, string>,
  key: string,
  isMapLoading: boolean,
  debounceMs = 300,
  { immediateCache = true } = {},
): DebouncedSettingResult {
  const mutation = useSetWorkspaceSetting();
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect((): (() => void) => {
    return (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const setValue = useCallback(
    (value: string) => {
      const bulkKey = getWorkspaceSettingsQueryKey();
      const singleKey = getGetWorkspaceSettingQueryKey(key);
      const previousBulk = queryClient.getQueryData<SettingEntry[]>(bulkKey);

      const warmBulkCache = (nextValue: string): void => {
        const existing = queryClient.getQueryData<SettingEntry[]>(bulkKey) ?? [];
        const idx = existing.findIndex((entry) => entry.key === key);
        const next: SettingEntry[] =
          idx >= 0
            ? existing.map((entry, i) => (i === idx ? { ...entry, value: nextValue } : entry))
            : [...existing, { key, value: nextValue }];
        queryClient.setQueryData(bulkKey, next);
        queryClient.setQueryData(singleKey, { value: nextValue });
      };

      if (immediateCache) {
        warmBulkCache(value);
      }

      if (timerRef.current) clearTimeout(timerRef.current);

      const persistValue = (): void => {
        mutation.mutate(
          { key, data: { value } },
          {
            onSuccess: () => {
              if (!immediateCache) warmBulkCache(value);
            },
            onError: (err: unknown) => {
              if (immediateCache) {
                if (previousBulk === undefined) {
                  void queryClient.invalidateQueries({ queryKey: bulkKey });
                } else {
                  queryClient.setQueryData(bulkKey, previousBulk);
                }
              }
              const message = apiErrorMessage(err, "Unknown error");
              toast.error(`Could not save setting "${key}": ${message}`);
            },
          },
        );
      };

      if (debounceMs <= 0) {
        persistValue();
        return;
      }

      timerRef.current = setTimeout(persistValue, debounceMs);
    },
    [key, debounceMs, immediateCache, mutation, queryClient],
  );

  const rawValue = map[key];
  const value = rawValue === undefined ? null : rawValue;
  return useMemo(
    () => ({ value, setValue, isLoading: isMapLoading }),
    [value, setValue, isMapLoading],
  );
}
