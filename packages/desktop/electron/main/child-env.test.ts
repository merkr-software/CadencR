import { describe, expect, it } from "vitest";
import { childProcessEnv } from "./child-env";

const appImageEnv = {
  HOME: "/home/ada",
  APPIMAGE: "/home/ada/Apps/Cadencr-0.15.0-x86_64.AppImage",
  APPDIR: "/tmp/.mount_CadencXYZ",
  OWD: "/home/ada",
  ARGV0: "./Cadencr.AppImage",
  PATH: "/tmp/.mount_CadencXYZ/usr/bin:/home/ada/.local/bin:/usr/bin",
  LD_LIBRARY_PATH: "/tmp/.mount_CadencXYZ/usr/lib",
  XDG_DATA_DIRS: "/tmp/.mount_CadencXYZ/usr/share:/usr/local/share:/usr/share",
  XDG_CURRENT_DESKTOP: "Unity",
  ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME",
  CHROME_DESKTOP: "cadencr.desktop",
};

describe("childProcessEnv", () => {
  it("removes the AppImage mount and runtime variables on Linux", () => {
    const env = childProcessEnv(appImageEnv, "linux");

    expect(env.PATH).toBe("/home/ada/.local/bin:/usr/bin");
    expect(env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
    expect(env).not.toHaveProperty("LD_LIBRARY_PATH");
    for (const key of ["APPIMAGE", "APPDIR", "OWD", "ARGV0", "CHROME_DESKTOP"]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.HOME).toBe("/home/ada");
  });

  it("restores the desktop name Electron replaced", () => {
    const env = childProcessEnv(appImageEnv, "linux");

    expect(env.XDG_CURRENT_DESKTOP).toBe("GNOME");
    expect(env).not.toHaveProperty("ORIGINAL_XDG_CURRENT_DESKTOP");
  });

  it("keeps a deb/rpm install's search paths, which have no AppImage mount", () => {
    const env = childProcessEnv(
      { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/custom/lib", XDG_CURRENT_DESKTOP: "KDE" },
      "linux",
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      LD_LIBRARY_PATH: "/opt/custom/lib",
      XDG_CURRENT_DESKTOP: "KDE",
    });
  });

  it("passes the environment through unchanged on macOS", () => {
    expect(childProcessEnv(appImageEnv, "darwin")).toEqual(appImageEnv);
  });

  it("does not mutate its input", () => {
    const input = { ...appImageEnv };
    childProcessEnv(input, "linux");
    expect(input).toEqual(appImageEnv);
  });
});
