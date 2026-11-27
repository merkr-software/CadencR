import { useUiTranslation } from "@/lib/i18n/ui";
import { McpToggleList } from "./McpToggleList";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";

export function McpSection(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsPageSection pageId="mcp">
      <SettingsGroup title={t("settings.mcp.builtInServers", "Built-in servers")}>
        <McpToggleList />
      </SettingsGroup>
    </SettingsPageSection>
  );
}
