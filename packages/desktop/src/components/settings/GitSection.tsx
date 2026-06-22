import { GitSettings } from "./GitSettings";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";

export function GitSection(): React.JSX.Element {
  return (
    <SettingsSection id="git" title="Git" subtitle="Header actions defaults">
      <SettingsCard
        padded
        title="Merge strategy"
        description={
          <>
            Default mode used by the{" "}
            <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">Merge</span> action
            in the feature top bar.
          </>
        }
      >
        <GitSettings />
      </SettingsCard>
    </SettingsSection>
  );
}
