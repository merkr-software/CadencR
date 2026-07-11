import { McpToggleList } from "./McpToggleList";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";

export function McpSection(): React.JSX.Element {
  return (
    <SettingsSection id="mcp" title="MCP" subtitle="Agent tool servers">
      <SettingsCard>
        <SettingsSubsection padded={false}>
          <McpToggleList />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
