import { useCallback, useMemo } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";

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
}

export function useRestartResumeEnabled(): UseRestartResumeResult {
  const setting = useDebouncedSetting(AGENT_RESTART_RESUME_SETTING_KEY, 0);
  const setEnabled = useCallback(
    (next: boolean) => setting.setValue(next ? "true" : "false"),
    [setting.setValue],
  );
  return useMemo(
    () => ({ enabled: setting.value !== "false", setEnabled, isLoading: setting.isLoading }),
    [setEnabled, setting.isLoading, setting.value],
  );
}
