import { useUiTranslation } from "@/lib/i18n/ui";
import { useSetting } from "@/hooks/useSetting";
import {
  NOTCH_ALWAYS_ANIMATE_KEY,
  NOTCH_ALWAYS_ON_KEY,
  useNotchPrefs,
} from "@/lib/notch/notch-prefs";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/** How the notch island behaves; rendered by `NotchSettings` while the notch is the destination. */
export function NotchBehaviorSettings(): React.JSX.Element {
  const { t } = useUiTranslation();
  const prefs = useNotchPrefs();
  const alwaysOn = useSetting(NOTCH_ALWAYS_ON_KEY);
  const alwaysAnimate = useSetting(NOTCH_ALWAYS_ANIMATE_KEY);

  return (
    <>
      <SettingsSwitchRow
        label={t("settings.notifications.notch.behavior.alwaysOn", "Always on")}
        description={t(
          "settings.notifications.notch.behavior.alwaysOnDescription",
          "Show compact activity while agents work, wait for you, or have unread replies. Off, it appears only on hover or for notifications. No status always hides compact activity on the primary display.",
        )}
        checked={prefs.alwaysOn}
        onCheckedChange={(next) => void alwaysOn.setValue(String(next))}
        disabled={alwaysOn.isLoading}
        saving={alwaysOn.isSaving}
        divided
      />
      <SettingsSwitchRow
        label={t("settings.notifications.notch.behavior.alwaysAnimate", "Always animate")}
        description={t(
          "settings.notifications.notch.behavior.alwaysAnimateDescription",
          "Animate the logo and working indicators even with the island closed. Waiting and finished session dots stay still. Off, animations run only once the island opens.",
        )}
        checked={prefs.alwaysAnimate}
        onCheckedChange={(next) => void alwaysAnimate.setValue(String(next))}
        disabled={alwaysAnimate.isLoading}
        saving={alwaysAnimate.isSaving}
        divided
      />
    </>
  );
}
