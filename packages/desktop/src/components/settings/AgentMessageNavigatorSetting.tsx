import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  AGENT_MESSAGE_NAVIGATOR_SETTING_KEY,
  parseAgentMessageNavigator,
} from "@/lib/agent-message-navigator";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

/**
 * Settings → Appearance → Agent transcript row toggling the agent tab's message navigator: the
 * rail of ticks marking each of your prompts along the stream's right edge.
 * Defaults to on.
 */
export function AgentMessageNavigatorSetting(): React.JSX.Element {
  const setting = useDebouncedSetting(AGENT_MESSAGE_NAVIGATOR_SETTING_KEY, 0);
  // Resolved, not the registry defaults: the text follows a user's rebinding.
  const previousCombo = useShortcutLabel("agent-previous-message");
  const nextCombo = useShortcutLabel("agent-next-message");

  return (
    <SettingsSwitchRow
      divided
      label="Message navigator"
      description={`Mark each of your messages with a small tick on the agent tab's right edge. Hover a tick to preview the message, click it to scroll there, or press ${previousCombo} / ${nextCombo}.`}
      checked={parseAgentMessageNavigator(setting.value)}
      onCheckedChange={(next) => setting.setValue(next ? "true" : "false")}
      disabled={setting.isLoading}
    />
  );
}
