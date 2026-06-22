import { Bot, Network, Search } from "lucide-react";
import {
  useBrowserMcpEnabled,
  useProjectMcpEnabled,
  useWorkspaceMcpEnabled,
} from "@/lib/mcp-settings";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function McpSection(): React.JSX.Element {
  const browserMcp = useBrowserMcpEnabled();
  const projectMcp = useProjectMcpEnabled();
  const workspaceMcp = useWorkspaceMcpEnabled();

  return (
    <SettingsSection id="mcp" title="MCP" subtitle="Agent tool servers">
      <SettingsCard>
        <SettingsSubsection padded={false}>
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
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
