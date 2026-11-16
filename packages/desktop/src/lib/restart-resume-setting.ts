import { useCallback, useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";

/**
 * Workspace setting: after a restart (an app update, a rebuild, a crash),
 * resume the agent turns it interrupted. Read by the service's
 * `restart_continuations` startup pass. Defaults to enabled.
 */
export const AGENT_RESTART_RESUME_SETTING_KEY = "agent_restart_resume_enabled";

export interface UseRestartResumeResult {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  isLoading: boolean;
  isSaving: boolean;
}

export function useRestartResumeEnabled(): UseRestartResumeResult {
  const setting = useSetting(AGENT_RESTART_RESUME_SETTING_KEY);
  const setEnabled = useCallback(
    (next: boolean) => setting.setValue(next ? "true" : "false"),
    [setting.setValue],
  );
  return useMemo(
    () => ({
      enabled: setting.value !== "false",
      setEnabled,
      isLoading: setting.isLoading,
      isSaving: setting.isSaving,
    }),
    [setEnabled, setting.isLoading, setting.isSaving, setting.value],
  );
}
