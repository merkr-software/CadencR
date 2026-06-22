import { createElement, useMemo } from "react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  BROWSER_DEFAULT_MODE_SETTING_KEY,
  BROWSER_MODE_OPTIONS,
  parseCookieMode,
  type CookieMode,
} from "@/lib/browser-settings";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";

/**
 * Browser workspace preferences:
 *  1. Default cookie mode (Normal / Private) used for the first tab and as the
 *     toolbar toggle's initial value.
 */
export function BrowserSection(): React.JSX.Element {
  const modeSetting = useDebouncedSetting(BROWSER_DEFAULT_MODE_SETTING_KEY, 0);
  const mode = parseCookieMode(modeSetting.value);

  const options = useMemo<RadioCardOption<CookieMode>[]>(
    () =>
      BROWSER_MODE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        visual: createElement(option.icon, {
          className: "mt-0.5 size-4",
          style: { color: option.iconColorVar },
        }),
      })),
    [],
  );

  return (
    <SettingsSection id="browser" title="Browser" subtitle="Default cookie mode">
      <SettingsCard>
        <SettingsSubsection
          title="Default mode"
          description="Which cookie mode new Browser tabs open in. Private sessions are in-memory only and cleared when the tab closes."
        >
          <RadioCardGroup<CookieMode>
            ariaLabel="Default browser mode"
            value={mode}
            onChange={modeSetting.setValue}
            options={options}
            layout="grid"
            showDot={false}
            disabled={modeSetting.isLoading}
          />
        </SettingsSubsection>
      </SettingsCard>
    </SettingsSection>
  );
}
