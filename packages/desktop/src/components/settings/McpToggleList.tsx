import { Bot, Network, Search } from "lucide-react";
import {
  useBrowserMcpEnabled,
  useProjectMcpEnabled,
  useWorkspaceMcpEnabled,
} from "@/lib/mcp-settings";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * The three built-in Cadencr MCP-server toggles (browser / project / workspace).
 * Extracted so both the Settings → MCP section and the onboarding Preferences
 * step render the same rows against the same setting keys. Each toggle
 * defaults to enabled and takes effect on the next agent turn.
 */
export function McpToggleList(): React.JSX.Element {
  const browserMcp = useBrowserMcpEnabled();
  const projectMcp = useProjectMcpEnabled();
  const workspaceMcp = useWorkspaceMcpEnabled();

  return (
    <>
      <SettingsSwitchRow
        icon={<Bot className="size-4" />}
        iconTint="cyan"
        label="Browser tools for agents"
        description="Expose the cadencr-browser MCP so agents can open localhost pages, inspect the console and network, and drive the Browser tab. Takes effect on the next agent turn."
        checked={browserMcp.enabled}
        onCheckedChange={browserMcp.setEnabled}
        disabled={browserMcp.isLoading}
      />
      <SettingsSwitchRow
        icon={<Network className="size-4" />}
        iconTint="purple"
        label="Project coordination for agents"
        description="Expose the cadencr-project MCP so agents can inspect, compare, spawn, and message sessions in the current project. Takes effect on the next agent turn."
        checked={projectMcp.enabled}
        onCheckedChange={projectMcp.setEnabled}
        disabled={projectMcp.isLoading}
        divided
      />
      <SettingsSwitchRow
        icon={<Search className="size-4" />}
        iconTint="green"
        label="Workspace memory for agents"
        description="Expose the cadencr-workspace MCP so agents can search and read conversation history across all Cadencr projects. Takes effect on the next agent turn."
        checked={workspaceMcp.enabled}
        onCheckedChange={workspaceMcp.setEnabled}
        disabled={workspaceMcp.isLoading}
        divided
      />
    </>
  );
}
