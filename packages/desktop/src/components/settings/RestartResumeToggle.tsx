import { useRestartResumeEnabled } from "@/lib/restart-resume-setting";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/**
 * Settings → General → Restarts row: resume the agents a restart interrupted. Updates,
 * reinstalled local builds and crashes all stop the agents' processes; with
 * this on, Cadencr picks each interrupted conversation back up on its next
 * start.
 */
export function RestartResumeToggle(): React.JSX.Element {
  const { enabled, setEnabled, isLoading } = useRestartResumeEnabled();
  return (
    <SettingsSwitchRow
      label="Resume agents after a restart"
      description="Updating or restarting Cadencr stops the agents that are working. When it starts again, Cadencr continues each interrupted conversation, asks the agent to redo what was cut off, and tells you which agents it resumed."
      checked={enabled}
      onCheckedChange={setEnabled}
      disabled={isLoading}
    />
  );
}
