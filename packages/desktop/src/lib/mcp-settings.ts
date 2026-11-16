import { useCallback, useMemo } from "react";
import { useSetting } from "@/hooks/useSetting";

/** Workspace setting toggling whether agents get the `cadencr-browser` MCP. */
export const BROWSER_MCP_ENABLED_SETTING_KEY = "browser_mcp_enabled";

/** Workspace setting toggling whether agents get the `cadencr-project` MCP. */
export const PROJECT_MCP_ENABLED_SETTING_KEY = "project_mcp_enabled";

/** Workspace setting toggling whether agents get the `cadencr-workspace` MCP. */
export const WORKSPACE_MCP_ENABLED_SETTING_KEY = "workspace_mcp_enabled";

export interface UseMcpEnabledResult {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  isLoading: boolean;
  isSaving: boolean;
}

function useMcpEnabledSetting(key: string): UseMcpEnabledResult {
  const setting = useSetting(key);
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

/** Toggle for exposing the `cadencr-browser` MCP to agents. Defaults to enabled. */
export function useBrowserMcpEnabled(): UseMcpEnabledResult {
  return useMcpEnabledSetting(BROWSER_MCP_ENABLED_SETTING_KEY);
}

/** Toggle for exposing the `cadencr-project` MCP to agents. Defaults to enabled. */
export function useProjectMcpEnabled(): UseMcpEnabledResult {
  return useMcpEnabledSetting(PROJECT_MCP_ENABLED_SETTING_KEY);
}

/** Toggle for exposing the `cadencr-workspace` MCP to agents. Defaults to enabled. */
export function useWorkspaceMcpEnabled(): UseMcpEnabledResult {
  return useMcpEnabledSetting(WORKSPACE_MCP_ENABLED_SETTING_KEY);
}
