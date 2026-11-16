import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useGetWorkspaceSetting } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { useSettingWriter } from "@/hooks/useSetting";

export const UNIFIED_AGENTS_PER_ROW_SETTING_KEY = "unified_agents_per_row";

export const AGENTS_PER_ROW_MIN = 1;
export const AGENTS_PER_ROW_MAX = 6;
const DEFAULT_AGENTS_PER_ROW = 3;

export interface UnifiedAgentsPerRowSetting {
  value: number;
  isLoading: boolean;
  isSaving: boolean;
  setValue: (value: number) => void;
}

export function useUnifiedAgentsPerRowSetting(): UnifiedAgentsPerRowSetting {
  const query = useGetWorkspaceSetting(UNIFIED_AGENTS_PER_ROW_SETTING_KEY);
  const { setValue: saveValue, isSaving } = useSettingWriter(UNIFIED_AGENTS_PER_ROW_SETTING_KEY);
  const value = parseUnifiedAgentsPerRowSetting(query.data?.value);

  useEffect((): void => {
    if (!query.isError) return;
    const message = apiErrorMessage(query.error, "Unknown error");
    toast.error(`Could not load agents-per-row setting: ${message}`);
  }, [query.error, query.isError]);

  const setValue = useCallback(
    (nextValue: number): void => {
      const normalizedValue = clampUnifiedAgentsPerRow(nextValue);
      if (normalizedValue === value) return;
      void saveValue(String(normalizedValue));
    },
    [saveValue, value],
  );

  return useMemo(
    () => ({
      value,
      isLoading: query.isLoading,
      isSaving,
      setValue,
    }),
    [isSaving, query.isLoading, setValue, value],
  );
}

export function parseUnifiedAgentsPerRowSetting(value: string | null | undefined): number {
  return clampUnifiedAgentsPerRow(Number.parseInt(value ?? "", 10));
}

function clampUnifiedAgentsPerRow(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENTS_PER_ROW;
  return Math.max(AGENTS_PER_ROW_MIN, Math.min(AGENTS_PER_ROW_MAX, Math.trunc(value)));
}
