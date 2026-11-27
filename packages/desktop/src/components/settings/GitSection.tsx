import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { GitDiffViewSettings } from "./GitDiffViewSettings";
import { GitRemotesSettings } from "./GitRemotesSettings";
import { GitSettings } from "./GitSettings";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

export function GitSection(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsPageSection pageId="git">
      <SettingsGroup
        id={SETTINGS_ANCHORS.merge}
        title={t("workspace.git.gitSection.mergeStrategy", "Merge strategy")}
        description={
          <UiTrans
            i18nKey="workspace.git.gitSection.mergeActionDescription"
            defaults="What the <action>Merge</action> action in a feature’s top bar does by default."
            components={{
              action: <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" />,
            }}
          />
        }
      >
        <SettingsSubsection>
          <GitSettings />
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.diff}
        title={t("workspace.git.gitSection.diffLayout", "Diff layout")}
        description={t(
          "workspace.git.gitSection.howDiffsAreDisplayedTheSplit",
          "How diffs are displayed. The Split / Unified toggle in the diff view changes this too.",
        )}
      >
        <SettingsSubsection>
          <GitDiffViewSettings />
        </SettingsSubsection>
      </SettingsGroup>
      <GitRemotesSettings />
    </SettingsPageSection>
  );
}
