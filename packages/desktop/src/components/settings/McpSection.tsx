import { McpToggleList } from "./McpToggleList";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";

export function McpSection(): React.JSX.Element {
  return (
    <SettingsPageSection pageId="mcp">
      <SettingsGroup title="Built-in servers">
        <McpToggleList />
      </SettingsGroup>
    </SettingsPageSection>
  );
}
