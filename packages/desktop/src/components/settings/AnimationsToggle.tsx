import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { useAnimationsEnabled } from "@/lib/animations/animations-setting";

/**
 * Settings → Appearance row that toggles UI animations on or off. When the
 * user hasn't explicitly chosen, the resolved value reflects the OS
 * `prefers-reduced-motion` preference; flipping the switch persists the
 * explicit override into the `animations_enabled` workspace setting.
 */
export function AnimationsToggle({ divided }: { divided?: boolean }): React.JSX.Element {
  const { enabled, systemReducedMotion, setEnabled, isLoading } = useAnimationsEnabled();

  const description = systemReducedMotion
    ? "Smooth fades and slides across menus, dialogs, and panels. Your system requests reduced motion, so animations are off by default."
    : "Smooth fades and slides across menus, dialogs, and panels. Disable for an instant, motion-free UI.";

  return (
    <SettingsSwitchRow
      label="Fluid animations"
      description={description}
      checked={enabled}
      onCheckedChange={setEnabled}
      disabled={isLoading}
      divided={divided}
    />
  );
}
