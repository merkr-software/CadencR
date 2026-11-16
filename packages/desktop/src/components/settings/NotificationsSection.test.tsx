import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import { NotificationsSection } from "./NotificationsSection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const platform = vi.hoisted(() => ({ desktopShell: false, remoteBrowser: false, notch: false }));

vi.mock("@/lib/desktop-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop-bridge")>()),
  isDesktopShell: () => platform.desktopShell,
}));
vi.mock("@/lib/remote/device-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/remote/device-token")>()),
  isBrowserRemote: () => platform.remoteBrowser,
}));
vi.mock("@/components/notch/useNotchCapabilities", () => ({
  useNotchDestinationActive: () => platform.notch,
}));
vi.mock("@/hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({ state: "loading", busy: false, toggle: vi.fn() }),
}));
vi.mock("./NotificationModePicker", () => ({ NotificationModePicker: () => null }));
vi.mock("./NotchBehaviorSettings", () => ({ NotchBehaviorSettings: () => null }));
vi.mock("./NotchDisplaySetting", () => ({ NotchDisplaySetting: () => null }));
vi.mock("./NotchPrimaryStyleSetting", () => ({ NotchPrimaryStyleSetting: () => null }));

function renderedAnchors(): string[] {
  const { container } = render(<NotificationsSection />);
  return [SETTINGS_ANCHORS.push, SETTINGS_ANCHORS.notch, SETTINGS_ANCHORS.notificationTest].filter(
    (id) => container.querySelector(`#${id}`) !== null,
  );
}

// The settings search hides these entries where the page doesn't render them
// (settings-availability); this pins the other half of that contract.
describe("NotificationsSection platform groups", () => {
  beforeEach(() => {
    Object.assign(platform, { desktopShell: false, remoteBrowser: false, notch: false });
  });

  it("renders the notch and the OS test notification in the desktop app with a notch", () => {
    Object.assign(platform, { desktopShell: true, notch: true });
    expect(renderedAnchors()).toEqual([SETTINGS_ANCHORS.notch, SETTINGS_ANCHORS.notificationTest]);
  });

  it("renders only the OS test notification in a desktop app without a notch (Linux)", () => {
    Object.assign(platform, { desktopShell: true });
    expect(renderedAnchors()).toEqual([SETTINGS_ANCHORS.notificationTest]);
  });

  it("renders push, and nothing native, in a remote browser", () => {
    Object.assign(platform, { remoteBrowser: true });
    expect(renderedAnchors()).toEqual([SETTINGS_ANCHORS.push]);
  });
});
