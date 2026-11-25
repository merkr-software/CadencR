import { useUiTranslation } from "@/lib/i18n/ui";
import { useRestartResumeEnabled } from "@/lib/restart-resume-setting";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Settings → General → Restarts row: resume the agents a restart interrupted. Updates,
 * reinstalled local builds and crashes all stop the agents' processes; with
 * this on, Cadencr picks each interrupted conversation back up on its next
 * start.
 */
export function RestartResumeToggle(): React.JSX.Element {
  const { t } = useUiTranslation();
  const { enabled, setEnabled, isLoading, isSaving } = useRestartResumeEnabled();
  return (
    <SettingsSwitchRow
      label={t("settings.general.restarts.resume", "Resume agents after a restart")}
      description={t(
        "settings.general.restarts.description",
        "After an update, a service restart, or a crash, Cadencr resumes interrupted agents and asks them to redo what was cut off. If you quit Cadencr, you can resume stopped work from its conversation.",
      )}
      checked={enabled}
      onCheckedChange={setEnabled}
      disabled={isLoading}
      saving={isSaving}
    />
  );
}
