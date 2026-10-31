import { isDesktopShell } from "@/lib/desktop-bridge";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import {
  SETTINGS_NAV_GROUPS,
  type SettingsNavGroup,
  type SettingsRequirement,
} from "./settings-catalog";

/** What this client is, as far as which settings it can show. */
export interface SettingsPlatform {
  desktopShell: boolean;
  remoteBrowser: boolean;
  mac: boolean;
  mobile: boolean;
}

export function currentSettingsPlatform(mobile: boolean): SettingsPlatform {
  return {
    desktopShell: isDesktopShell(),
    remoteBrowser: isBrowserRemote(),
    mac: PLATFORM_IS_MAC,
    mobile,
  };
}

function meets(requirement: SettingsRequirement, platform: SettingsPlatform): boolean {
  switch (requirement) {
    case "desktop-shell":
      return platform.desktopShell;
    case "macos-desktop":
      return platform.desktopShell && platform.mac;
    case "remote-browser":
      return platform.remoteBrowser;
    case "wide-screen":
      return !platform.mobile;
  }
}

/**
 * The catalog without the settings this client never renders (the notch off
 * macOS, push outside a remote browser…), so search and the palette don't
 * offer a result that lands on nothing.
 */
export function availableSettingsGroups(
  platform: SettingsPlatform,
  groups: readonly SettingsNavGroup[] = SETTINGS_NAV_GROUPS,
): SettingsNavGroup[] {
  return groups.map((group) => ({
    ...group,
    pages: group.pages.map((page) => ({
      ...page,
      entries: page.entries.filter(
        (entry) => entry.requires === undefined || meets(entry.requires, platform),
      ),
    })),
  }));
}
