import { ModelSelector } from "@/components/ModelSelector";
import { AutoNamePromptSetting } from "./AutoNamePromptSetting";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";

export function RuntimeSettingsSection(): React.JSX.Element {
  return (
    <SettingsSection id="runtime" title="Runtime & Models" subtitle="Per-agent provider & model">
      <SettingsCard>
        <ModelSelector level="global" />
        <SettingsSubsection title="Session auto-naming">
          <AutoNamePromptSetting />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
