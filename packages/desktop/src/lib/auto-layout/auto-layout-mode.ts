import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  getGetFeatureSettingsQueryKey,
  useGetFeatureSettings,
  useGetWorkspaceSetting,
  useSetFeatureSetting,
  type FeatureSetting,
} from "@/api/generated";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Workspace default for auto layout, `"true"` / `"false"`; unset means on.
 * Mirrors `layout_auto_mode_default` in the service's settings allowlist.
 */
export const AUTO_LAYOUT_DEFAULT_KEY = "layout_auto_mode_default";

/**
 * Per-feature override, `"on"` / `"off"`; unset follows the workspace default.
 * Mirrors `layout_auto_mode` in the service's feature settings allowlist.
 */
export const AUTO_LAYOUT_FEATURE_KEY = "layout_auto_mode";

export function resolveAutoLayoutMode(
  featureValue: string | null | undefined,
  defaultValue: string | null | undefined,
): boolean {
  if (featureValue === "on") return true;
  if (featureValue === "off") return false;
  return defaultValue !== "false";
}

/** The workspace-wide default, read and written from Settings. */
export function useAutoLayoutDefault(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  isBusy: boolean;
} {
  const setting = useDebouncedSetting(AUTO_LAYOUT_DEFAULT_KEY, 0, { immediateCache: false });
  const { setValue } = setting;
  const setEnabled = useCallback((next: boolean) => setValue(String(next)), [setValue]);
  return {
    enabled: setting.value !== "false",
    setEnabled,
    isBusy: setting.isLoading || setting.isSaving,
  };
}

function selectFeatureMode(settings: FeatureSetting[]): string | null {
  return settings.find((s) => s.key === AUTO_LAYOUT_FEATURE_KEY)?.value ?? null;
}

/**
 * Effective auto layout mode for one feature: its override, else the
 * workspace default. Read-only, and it only re-renders when that one setting
 * changes, not on every other feature setting write (prompt drafts, layout).
 */
export function useAutoLayoutActive(
  featureId: number,
  enabled = true,
): { active: boolean; isLoading: boolean } {
  const defaultQuery = useGetWorkspaceSetting(AUTO_LAYOUT_DEFAULT_KEY, { query: { enabled } });
  const featureQuery = useGetFeatureSettings(featureId, {
    query: { enabled, select: selectFeatureMode },
  });
  const isLoading = defaultQuery.isLoading || featureQuery.isLoading;
  return {
    // Off until both settings are in: on by default must not briefly override
    // a feature (or workspace) the user switched off.
    active: !isLoading && resolveAutoLayoutMode(featureQuery.data, defaultQuery.data?.value),
    isLoading,
  };
}

interface AutoLayoutModeResult {
  active: boolean;
  isLoading: boolean;
  isSaving: boolean;
  setActive: (next: boolean) => void;
}

/** `useAutoLayoutActive` plus the per-feature toggle. */
export function useAutoLayoutMode(featureId: number): AutoLayoutModeResult {
  const queryClient = useQueryClient();
  const { active, isLoading } = useAutoLayoutActive(featureId);
  const { mutate, isPending } = useSetFeatureSetting();

  const setActive = useCallback(
    (next: boolean): void => {
      const value = next ? "on" : "off";
      mutate(
        { id: featureId, data: { key: AUTO_LAYOUT_FEATURE_KEY, value } },
        {
          onSuccess: (): void => {
            // Reflect the confirmed write; nothing else changed, so no refetch.
            queryClient.setQueryData<FeatureSetting[]>(
              getGetFeatureSettingsQueryKey(featureId),
              (prev) => [
                ...(prev ?? []).filter((s) => s.key !== AUTO_LAYOUT_FEATURE_KEY),
                { key: AUTO_LAYOUT_FEATURE_KEY, value },
              ],
            );
          },
          onError: (err: unknown): void => {
            toast.error(`Could not change auto layout: ${apiErrorMessage(err, "Unknown error")}`);
          },
        },
      );
    },
    [featureId, mutate, queryClient],
  );

  return useMemo(
    () => ({ active, isLoading, isSaving: isPending, setActive }),
    [active, isLoading, isPending, setActive],
  );
}
