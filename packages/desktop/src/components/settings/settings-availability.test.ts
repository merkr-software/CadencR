import { describe, expect, it } from "vitest";
import { availableSettingsGroups, type SettingsPlatform } from "./settings-availability";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const DESKTOP_MAC: SettingsPlatform = {
  desktopShell: true,
  remoteBrowser: false,
  mac: true,
  mobile: false,
};

function anchors(platform: SettingsPlatform): string[] {
  return availableSettingsGroups(platform).flatMap((group) =>
    group.pages.flatMap((page) => page.entries.flatMap((entry) => entry.anchor ?? [])),
  );
}

describe("availableSettingsGroups", () => {
  it("offers the notch and the OS test notification only in the macOS desktop app", () => {
    expect(anchors(DESKTOP_MAC)).toEqual(
      expect.arrayContaining([SETTINGS_ANCHORS.notch, SETTINGS_ANCHORS.notificationTest]),
    );
    expect(anchors(DESKTOP_MAC)).not.toContain(SETTINGS_ANCHORS.push);
  });

  it("keeps the OS test notification but not the notch in the Linux desktop app", () => {
    const linux = anchors({ ...DESKTOP_MAC, mac: false });
    expect(linux).toContain(SETTINGS_ANCHORS.notificationTest);
    expect(linux).not.toContain(SETTINGS_ANCHORS.notch);
  });

  it("swaps native notifications for push in a remote browser, whatever its OS", () => {
    const remote = anchors({ desktopShell: false, remoteBrowser: true, mac: true, mobile: false });
    expect(remote).toContain(SETTINGS_ANCHORS.push);
    expect(remote).not.toContain(SETTINGS_ANCHORS.notch);
    expect(remote).not.toContain(SETTINGS_ANCHORS.notificationTest);
  });

  it("drops the browser's auto layout on a phone", () => {
    expect(anchors(DESKTOP_MAC)).toContain(SETTINGS_ANCHORS.browserLayout);
    expect(anchors({ ...DESKTOP_MAC, mobile: true })).not.toContain(SETTINGS_ANCHORS.browserLayout);
  });

  it("keeps every page, even when one loses settings", () => {
    const pages = (platform: SettingsPlatform) =>
      availableSettingsGroups(platform).flatMap((group) => group.pages.map((page) => page.id));
    expect(pages({ desktopShell: false, remoteBrowser: true, mac: false, mobile: true })).toEqual(
      pages(DESKTOP_MAC),
    );
  });
});
