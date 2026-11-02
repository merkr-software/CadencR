import { GitDiffViewSettings } from "./GitDiffViewSettings";
import { GitRemotesSettings } from "./GitRemotesSettings";
import { GitSettings } from "./GitSettings";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

export function GitSection(): React.JSX.Element {
  return (
    <SettingsPageSection pageId="git">
      <SettingsGroup
        id={SETTINGS_ANCHORS.merge}
        title="Merge strategy"
        description={
          <>
            What the{" "}
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">Merge</span> action
            in a feature's top bar does by default.
          </>
        }
      >
        <SettingsSubsection>
          <GitSettings />
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup
        id={SETTINGS_ANCHORS.diff}
        title="Diff layout"
        description="How diffs are displayed. The Split / Unified toggle in the diff view changes this too."
      >
        <SettingsSubsection>
          <GitDiffViewSettings />
        </SettingsSubsection>
      </SettingsGroup>
      <GitRemotesSettings />
    </SettingsPageSection>
  );
}
