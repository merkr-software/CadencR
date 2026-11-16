import { useCallback, useMemo } from "react";
import { useQueries, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetWorkspaceSettingQueryOptions,
  useSetWorkspaceSettingsBatch,
  type Setting,
  type SettingValueResponse,
} from "@/api/generated";
import { seedConfirmedSetting, writeSetting } from "@/hooks/setting-persistence";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  parseSidebarConfig,
  serializeSidebarOption,
  SIDEBAR_OPTIONS,
  SIDEBAR_SETTING_KEYS,
  type SidebarConfig,
  type SidebarOptionId,
} from "@/lib/sidebar-config";
import {
  sidebarDisplayValues,
  sidebarPresetValues,
  type SidebarPresetId,
} from "@/lib/sidebar-presets";

interface SidebarSettings {
  config: SidebarConfig;
  /** False until every key settled once: the config is still all defaults. */
  isFetched: boolean;
}

interface SettingResult {
  data?: SettingValueResponse;
  isFetched: boolean;
}

// Module-level so TanStack can memoize the combined result between renders.
function combineSidebarSettings(results: SettingResult[]): SidebarSettings {
  const byKey = new Map(SIDEBAR_SETTING_KEYS.map((key, index) => [key, results[index]]));
  return {
    config: parseSidebarConfig((key) => byKey.get(key)?.data?.value),
    isFetched: results.every((result) => result.isFetched),
  };
}

/**
 * The sidebar display options straight from the settings queries. Each key is
 * its own query, but `api/client.ts` serves them all from one bulk request.
 * Never stale on a timer: writes patch the cache and the settings watcher's
 * `settings_event` invalidates it, so remounting the form refetches nothing.
 * Rows read the mirrored store instead (see `useSidebarOption`).
 */
export function useSidebarSettings(): SidebarSettings {
  return useQueries({
    queries: SIDEBAR_SETTING_KEYS.map((key) =>
      getGetWorkspaceSettingQueryOptions(key, { query: { staleTime: Infinity } }),
    ),
    combine: combineSidebarSettings,
  });
}

type SetSidebarOption = <K extends SidebarOptionId>(id: K, value: SidebarConfig[K]) => void;

/**
 * Persists one option. Like every setting, the cache only moves once the write
 * is confirmed (no optimistic updates); a failed write says why.
 */
export function useSetSidebarOption(): SetSidebarOption {
  const queryClient = useQueryClient();
  return useCallback<SetSidebarOption>(
    (id, value) =>
      void writeSetting(queryClient, SIDEBAR_OPTIONS[id].key, serializeSidebarOption(value)),
    [queryClient],
  );
}

/** Seeds each written key's cache from a batch write's response (absent means cleared). */
export function seedSettingsFromBatch(
  queryClient: QueryClient,
  keys: readonly string[],
  saved: readonly Setting[],
): void {
  for (const key of keys) {
    seedConfirmedSetting(
      queryClient,
      key,
      saved.find((setting) => setting.key === key)?.value ?? null,
    );
  }
}

interface SidebarConfigWrites {
  /** Clears every display option, so the defaults (the Classic preset) apply. */
  reset: () => void;
  /** Writes a preset's values and clears every option it doesn't set (L1). */
  applyPreset: (presetId: SidebarPresetId) => void;
  /** Writes back every display option of a config, undoing a preset. */
  restore: (config: SidebarConfig) => void;
  /** A reset or preset write is in flight. */
  isApplying: boolean;
}

/**
 * Whole-config writes, each one batch so the sidebar never shows half a
 * preset. The response seeds the sidebar keys; the settings watcher's echo
 * refreshes the rest.
 */
export function useSidebarConfigWrites(): SidebarConfigWrites {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useSetWorkspaceSettingsBatch({
    mutation: {
      onSuccess: (settings) => seedSettingsFromBatch(queryClient, SIDEBAR_SETTING_KEYS, settings),
      onError: (error) =>
        toast.error(`Could not update the sidebar: ${apiErrorMessage(error, "Unknown error")}`),
    },
  });
  const applyPreset = useCallback(
    (presetId: SidebarPresetId) => mutate({ data: { values: sidebarPresetValues(presetId) } }),
    [mutate],
  );
  const restore = useCallback(
    (config: SidebarConfig) => mutate({ data: { values: sidebarDisplayValues(config) } }),
    [mutate],
  );
  const reset = useCallback(() => applyPreset("classic"), [applyPreset]);
  return useMemo(
    () => ({ reset, applyPreset, restore, isApplying: isPending }),
    [reset, applyPreset, restore, isPending],
  );
}
