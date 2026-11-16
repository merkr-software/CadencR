import { useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";
import { MONO_FONT_SETTING_KEY, resolveMonoStack } from "@/lib/fonts/constants";

interface UseMonoFontResult {
  /** The user's chosen family, or null when unset ("Default"). */
  family: string | null;
  /** The full CSS font-family value to apply. */
  resolved: string;
  setFamily: (value: string) => void;
  isLoading: boolean;
}

/**
 * Workspace setting persisting the user's monospace font family. A missing
 * value means "Default" and resolves to DEFAULT_MONO_STACK. Mirrors
 * `mono_font_family` in packages/service settings allowlist.
 */
export function useMonoFont(): UseMonoFontResult {
  const setting = useSetting(MONO_FONT_SETTING_KEY);
  const family = setting.value || null;
  return useMemo(
    () => ({
      family,
      resolved: resolveMonoStack(family),
      setFamily: setting.setValue,
      isLoading: setting.isLoading,
    }),
    [family, setting.isLoading, setting.setValue],
  );
}
