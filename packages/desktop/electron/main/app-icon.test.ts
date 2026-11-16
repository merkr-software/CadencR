import { describe, expect, it } from "vitest";
import { LINUX_DESKTOP_NAME, resolveWindowIconPath, windowIconOption } from "./app-icon";

describe("app icon helpers", () => {
  it("uses the installed desktop filename for Linux window/app identity", () => {
    expect(LINUX_DESKTOP_NAME).toBe("cadencr.desktop");
  });

  it("resolves the dev Linux window icon from the app path", () => {
    expect(
      resolveWindowIconPath({
        appPath: "/repo/packages/desktop",
        isPackaged: false,
        platform: "linux",
        resourcesPath: "/opt/Cadencr/resources",
      }),
    ).toBe("/repo/packages/desktop/icons/512x512.png");
  });

  it("resolves the packaged Linux window icon from extra resources", () => {
    expect(
      windowIconOption({
        appPath: "/opt/Cadencr/resources/app.asar",
        isPackaged: true,
        platform: "linux",
        resourcesPath: "/opt/Cadencr/resources",
      }),
    ).toEqual({ icon: "/opt/Cadencr/resources/icons/512x512.png" });
  });

  it("does not set a per-window icon on non-Linux platforms", () => {
    expect(
      resolveWindowIconPath({
        appPath: "/Applications/Cadencr.app/Contents/Resources/app.asar",
        isPackaged: true,
        platform: "darwin",
        resourcesPath: "/Applications/Cadencr.app/Contents/Resources",
      }),
    ).toBeNull();
  });
});
