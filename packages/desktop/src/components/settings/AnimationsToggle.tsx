import { useUiTranslation } from "@/lib/i18n/ui";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { useAnimationsEnabled } from "@/lib/animations/animations-setting";

/**
 * Settings → Appearance row that toggles UI animations on or off. When the
 * user hasn't explicitly chosen, the resolved value reflects the OS
 * `prefers-reduced-motion` preference; flipping the switch persists the
 * explicit override into the `animations_enabled` workspace setting.
 */
export function AnimationsToggle({ divided }: { divided?: boolean }): React.JSX.Element {
  const { t } = useUiTranslation();
  const { enabled, systemReducedMotion, setEnabled, isLoading, isSaving } = useAnimationsEnabled();

  const description = systemReducedMotion
    ? t(
        "appearance.animations.reducedMotionDescription",
        "Smooth fades and slides across menus, dialogs, and panels. Your system requests reduced motion, so animations are off by default.",
      )
    : t(
        "appearance.animations.description",
        "Smooth fades and slides across menus, dialogs, and panels. Disable for an instant, motion-free UI.",
      );

  return (
    <SettingsSwitchRow
      label={t("appearance.animations.label", "Fluid animations")}
      description={description}
      checked={enabled}
      onCheckedChange={setEnabled}
      disabled={isLoading}
      saving={isSaving}
      divided={divided}
    />
  );
}
