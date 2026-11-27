import { useUiTranslation } from "@/lib/i18n/ui";
import { useSetting } from "@/hooks/useSetting";
import {
  AGENT_MESSAGE_NAVIGATOR_SETTING_KEY,
  parseAgentMessageNavigator,
} from "@/lib/agent-message-navigator";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";
import { useShowsKeyboardHints } from "@/hooks/useShowsKeyboardHints";

/**
 * Settings → Appearance → Agent transcript row toggling the agent tab's message navigator: the
 * rail of ticks marking each of your prompts along the stream's right edge.
 * Defaults to on.
 */
export function AgentMessageNavigatorSetting(): React.JSX.Element {
  const { t } = useUiTranslation();
  const setting = useSetting(AGENT_MESSAGE_NAVIGATOR_SETTING_KEY);
  // Resolved, not the registry defaults: the text follows a user's rebinding.
  const previousCombo = useShortcutLabel("agent-previous-message");
  const nextCombo = useShortcutLabel("agent-next-message");
  const showsKeys = useShowsKeyboardHints();

  return (
    <SettingsSwitchRow
      divided
      label={t("appearance.transcript.messageNavigator", "Message navigator")}
      description={
        showsKeys
          ? t(
              "appearance.transcript.messageNavigatorDescription",
              "Mark each of your messages with a small tick on the agent tab's right edge. Hover a tick to preview the message, click it to scroll there, or press {{previousCombo}} / {{nextCombo}}.",
              { previousCombo, nextCombo },
            )
          : t(
              "appearance.transcript.messageNavigatorDescriptionTouch",
              "Mark each of your messages with a small tick on the agent tab's right edge. Tap a tick to scroll to its message.",
            )
      }
      checked={parseAgentMessageNavigator(setting.value)}
      onCheckedChange={(next) => setting.setValue(next ? "true" : "false")}
      disabled={setting.isLoading}
      saving={setting.isSaving}
    />
  );
}
