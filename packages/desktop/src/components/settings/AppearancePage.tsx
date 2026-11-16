import { ThemeLibrary } from "@/components/theme/ThemeLibrary";
import { AgentMessageNavigatorSetting } from "./AgentMessageNavigatorSetting";
import { AgentSummaryModeToggle } from "./AgentSummaryModeToggle";
import { AgentVerbositySettings } from "./AgentVerbositySettings";
import { AnimationsToggle } from "./AnimationsToggle";
import { FontSelector } from "./FontSelector";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { ThemeSelector } from "./ThemeSelector";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

/**
 * Settings → Appearance: how Cadencr looks, agent transcripts included —
 * those options change what you see, never what an agent does.
 */
export function AppearancePage(): React.JSX.Element {
  return (
    <SettingsPageSection pageId="appearance">
      <SettingsGroup id={SETTINGS_ANCHORS.theme} title="Theme & motion">
        <ThemeSelector />
        <AnimationsToggle divided />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.font}
        title="Monospace font"
        description="Used by the terminal, the editor and code snippets."
      >
        <FontSelector />
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.themeLibrary}
        title="Theme library"
        description="Start from any theme and make it your own. Each one gets a project in the sidebar: edit its JSON or ask an agent, and the app restyles as you go. Your themes join the built-ins in the picker."
      >
        <SettingsSubsection>
          <ThemeLibrary />
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.agentOutput}
        title="Agent transcript"
        description="How much of each agent turn stays expanded in the stream. This only changes what you see, never what the agent does."
      >
        <SettingsSubsection>
          <AgentVerbositySettings />
        </SettingsSubsection>
        <AgentSummaryModeToggle />
        <AgentMessageNavigatorSetting />
      </SettingsGroup>
    </SettingsPageSection>
  );
}
