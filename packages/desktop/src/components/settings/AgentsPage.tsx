import { useUiTranslation } from "@/lib/i18n/ui";
import { ModelSelector } from "@/components/ModelSelector";
import { AutoNamePromptSetting } from "./AutoNamePromptSetting";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const AUTO_NAME_ONLY = ["auto_name"] as const;

/**
 * Settings → Agents: what applies to every agent whichever provider runs it.
 * Provider-specific options live on the Providers page; how a transcript reads
 * is an Appearance setting.
 */
export function AgentsPage(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsPageSection pageId="agents">
      <SettingsGroup
        id={SETTINGS_ANCHORS.autoNaming}
        title={t("settings.agents.naming.title", "Conversation names")}
        description={t(
          "settings.agents.naming.description",
          "The model and prompt that title each new conversation.",
        )}
      >
        <SettingsSubsection title={t("settings.agents.naming.model", "Naming model")}>
          <ModelSelector level="global" agentTypes={AUTO_NAME_ONLY} />
        </SettingsSubsection>
        <AutoNamePromptSetting />
      </SettingsGroup>
    </SettingsPageSection>
  );
}
