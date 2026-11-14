import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliInstallContext } from "./cli-install-context";
import { cliInstallStatus, installCli, refreshInstalledCli, uninstallCli } from "./cli-install";

let root: string;

function writeExecutable(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function context(overrides: Partial<CliInstallContext> = {}): CliInstallContext {
  const resourcesPath = path.join(root, "Cadencr.app", "Contents", "Resources");
  return {
    platform: "darwin",
    isPackaged: true,
    appVersion: "1.0.0",
    resourcesPath,
    env: { PATH: "/usr/bin" },
    loginPathDirs: [],
    homedir: path.join(root, "home"),
    linuxInstallType: "unknown",
    macBinDir: path.join(root, "usr-local-bin"),
    runPrivileged: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function appImageContext(overrides: Partial<CliInstallContext> = {}): CliInstallContext {
  return context({
    platform: "linux",
    linuxInstallType: "appimage",
    resourcesPath: path.join(root, "mount", "resources"),
    env: {
      APPIMAGE: path.join(root, "Apps", "Cadencr.AppImage"),
      PATH: path.join(root, "home", ".local", "bin"),
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cadencr-cli-install-")));
  writeExecutable(path.join(root, "Cadencr.app/Contents/Resources/bin/cadencr"), "cli v1");
  writeExecutable(path.join(root, "mount/resources/bin/cadencr"), "cli v1");
});
afterEach(() => {
  fs.chmodSync(root, 0o755);
  if (fs.existsSync(path.join(root, "usr-local-bin"))) {
    fs.chmodSync(path.join(root, "usr-local-bin"), 0o755);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cliInstallStatus", () => {
  it("is unavailable in development builds", async () => {
    const status = await cliInstallStatus(context({ isPackaged: false }));
    expect(status).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/pnpm/) });
  });

  it("is unavailable when the build has no bundled command", async () => {
    fs.rmSync(path.join(root, "Cadencr.app/Contents/Resources/bin/cadencr"));
    expect(await cliInstallStatus(context())).toMatchObject({ state: "unavailable" });
  });

  it("leaves DEB and RPM installs to their package", async () => {
    for (const linuxInstallType of ["deb", "rpm"] as const) {
      const status = await cliInstallStatus(context({ platform: "linux", linuxInstallType }));
      expect(status).toEqual({ state: "package", path: "/usr/bin/cadencr" });
    }
  });

  it("refuses unofficial Linux builds", async () => {
    const status = await cliInstallStatus(context({ platform: "linux" }));
    expect(status).toMatchObject({
      state: "unavailable",
      reason: expect.stringMatching(/official/),
    });
  });

  it("macOS: reports a missing command and whether its directory is on PATH", async () => {
    const ctx = context({ env: { PATH: `/usr/bin:${path.join(root, "usr-local-bin")}` } });
    expect(await cliInstallStatus(ctx)).toEqual({
      state: "not-installed",
      target: path.join(root, "usr-local-bin", "cadencr"),
      onPath: true,
    });
  });

  it("macOS: counts a login shell's PATH, which the Dock-started app lacks", async () => {
    const ctx = context({ loginPathDirs: [path.join(root, "usr-local-bin")] });
    expect(await cliInstallStatus(ctx)).toMatchObject({ state: "not-installed", onPath: true });
  });

  it("macOS: refuses to link into a disk image or a translocated copy", async () => {
    for (const resourcesPath of [
      "/Volumes/Cadencr/Cadencr.app/Contents/Resources",
      "/private/var/folders/x/AppTranslocation/ABC/d/Cadencr.app/Contents/Resources",
    ]) {
      expect(await cliInstallStatus(context({ resourcesPath }))).toMatchObject({
        state: "unavailable",
        reason: expect.stringMatching(/Move Cadencr to Applications/),
      });
    }
  });

  it("macOS: tells this app's link, another Cadencr's link and a foreign program apart", async () => {
    const ctx = context();
    const target = path.join(ctx.macBinDir, "cadencr");
    fs.mkdirSync(ctx.macBinDir);
    fs.symlinkSync(path.join(ctx.resourcesPath, "bin", "cadencr"), target);
    expect(await cliInstallStatus(ctx)).toMatchObject({ state: "installed", current: true });

    fs.rmSync(target);
    fs.symlinkSync("/Volumes/Old/Cadencr.app/Contents/Resources/bin/cadencr", target);
    expect(await cliInstallStatus(ctx)).toMatchObject({ state: "installed", current: false });

    fs.rmSync(target);
    fs.symlinkSync("/opt/homebrew/bin/other", target);
    expect(await cliInstallStatus(ctx)).toMatchObject({
      state: "conflict",
      existing: "a link to /opt/homebrew/bin/other",
    });

    fs.rmSync(target);
    writeExecutable(target, "#!/bin/sh\n");
    expect(await cliInstallStatus(ctx)).toMatchObject({
      state: "conflict",
      existing: "a program not installed by Cadencr",
    });
  });
});

describe("macOS install", () => {
  it("links the bundled command and removes it again", async () => {
    const ctx = context();
    const installed = await installCli(ctx, { replace: false });
    expect(installed).toMatchObject({ state: "installed", current: true });
    expect(fs.readlinkSync(path.join(ctx.macBinDir, "cadencr"))).toBe(
      path.join(ctx.resourcesPath, "bin", "cadencr"),
    );
    expect(await uninstallCli(ctx)).toMatchObject({ state: "not-installed" });
  });

  it("never replaces a foreign command without confirmation", async () => {
    const ctx = context();
    writeExecutable(path.join(ctx.macBinDir, "cadencr"), "foreign");
    await expect(installCli(ctx, { replace: false })).rejects.toThrow(/already exists/);
    await expect(uninstallCli(ctx)).rejects.toThrow(/not installed by Cadencr/);
    expect(await installCli(ctx, { replace: true })).toMatchObject({ state: "installed" });
  });

  it("asks for administrator rights when the directory is not writable", async () => {
    const ctx = context();
    fs.mkdirSync(ctx.macBinDir);
    fs.chmodSync(ctx.macBinDir, 0o555);
    await installCli(ctx, { replace: false });
    const source = path.join(ctx.resourcesPath, "bin", "cadencr");
    const target = path.join(ctx.macBinDir, "cadencr");
    expect(ctx.runPrivileged).toHaveBeenCalledWith(expect.stringContaining("quoted form of"), [
      source,
      target,
      ctx.macBinDir,
    ]);
  });
});

describe("AppImage install", () => {
  const target = () => path.join(root, "home", ".local", "bin", "cadencr");
  const locator = () => path.join(root, "config", "cadencr", "cli.json");

  it("copies the command out of the mount and records the AppImage", async () => {
    const ctx = appImageContext();
    expect(await installCli(ctx, { replace: false })).toEqual({
      state: "installed",
      target: target(),
      onPath: true,
      current: true,
    });
    expect(fs.readFileSync(target(), "utf8")).toBe("cli v1");
    expect(fs.statSync(target()).mode & 0o777).toBe(0o755);
    expect(JSON.parse(fs.readFileSync(locator(), "utf8"))).toEqual({
      version: 1,
      appimage: ctx.env.APPIMAGE,
      appVersion: "1.0.0",
      sha256: createHash("sha256").update("cli v1").digest("hex"),
    });
    expect(await uninstallCli(ctx)).toMatchObject({ state: "not-installed" });
    expect(fs.existsSync(locator())).toBe(false);
  });

  it("treats a command without a locator as foreign", async () => {
    writeExecutable(target(), "someone else's");
    expect(await cliInstallStatus(appImageContext())).toMatchObject({ state: "conflict" });
  });

  it("refuses to install without APPIMAGE", async () => {
    const ctx = appImageContext({ env: { PATH: "" } });
    await expect(installCli(ctx, { replace: false })).rejects.toThrow(/APPIMAGE/);
  });

  it("refreshes a stale copy and a moved AppImage at launch", async () => {
    await installCli(appImageContext(), { replace: false });
    writeExecutable(path.join(root, "mount/resources/bin/cadencr"), "cli v2");
    const moved = appImageContext({
      env: {
        APPIMAGE: path.join(root, "Moved.AppImage"),
        XDG_CONFIG_HOME: path.join(root, "config"),
      },
    });
    expect(await cliInstallStatus(moved)).toMatchObject({ state: "installed", current: false });
    await refreshInstalledCli(moved);
    expect(fs.readFileSync(target(), "utf8")).toBe("cli v2");
    expect(JSON.parse(fs.readFileSync(locator(), "utf8")).appimage).toBe(moved.env.APPIMAGE);
    expect(await cliInstallStatus(moved)).toMatchObject({ state: "installed", current: true });
  });

  it("refreshes the copy after an app update, and only then", async () => {
    await installCli(appImageContext(), { replace: false });
    writeExecutable(path.join(root, "mount/resources/bin/cadencr"), "cli v2");
    await refreshInstalledCli(appImageContext());
    expect(fs.readFileSync(target(), "utf8")).toBe("cli v1");
    const updated = appImageContext({ appVersion: "1.1.0" });
    expect(await cliInstallStatus(updated)).toMatchObject({ state: "installed", current: false });
    await refreshInstalledCli(updated);
    expect(fs.readFileSync(target(), "utf8")).toBe("cli v2");
    expect(await cliInstallStatus(updated)).toMatchObject({ state: "installed", current: true });
  });

  it("never overwrites or removes a command that replaced Cadencr's", async () => {
    await installCli(appImageContext(), { replace: false });
    writeExecutable(target(), "someone else's");
    const updated = appImageContext({ appVersion: "1.1.0" });
    expect(await cliInstallStatus(updated)).toMatchObject({ state: "conflict" });
    await refreshInstalledCli(updated);
    expect(fs.readFileSync(target(), "utf8")).toBe("someone else's");
    await expect(uninstallCli(updated)).rejects.toThrow(/not installed by Cadencr/);
    expect(fs.readFileSync(target(), "utf8")).toBe("someone else's");
  });

  it("leaves a never-installed command alone at launch", async () => {
    await refreshInstalledCli(appImageContext());
    expect(fs.existsSync(target())).toBe(false);
  });
});
