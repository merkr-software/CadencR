import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLinuxInstallType } from "./linux-install-type";

describe("detectLinuxInstallType", () => {
  let tmpDir: string;
  let osReleasePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cadencr-os-release-"));
    osReleasePath = join(tmpDir, "os-release");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns appimage when APPIMAGE is set, regardless of distro", () => {
    writeFileSync(osReleasePath, 'ID=fedora\nID_LIKE="rhel centos fedora"\n');
    const info = detectLinuxInstallType({ APPIMAGE: "/tmp/Cadencr.AppImage" }, osReleasePath);
    expect(info.type).toBe("appimage");
    expect(info.message).toBe("");
  });

  it("detects Ubuntu as deb", () => {
    writeFileSync(osReleasePath, "ID=ubuntu\nID_LIKE=debian\n");
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("deb");
    expect(info.message).toMatch(/apt upgrade cadencr/);
  });

  it("detects Debian as deb", () => {
    writeFileSync(osReleasePath, "ID=debian\n");
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("deb");
  });

  it("detects Pop!_OS (debian-derived) as deb via ID_LIKE", () => {
    writeFileSync(osReleasePath, 'ID=pop\nID_LIKE="ubuntu debian"\n');
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("deb");
  });

  it("detects Fedora as rpm", () => {
    writeFileSync(osReleasePath, "ID=fedora\n");
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("rpm");
    expect(info.message).toMatch(/dnf upgrade cadencr/);
  });

  it("detects Rocky Linux as rpm via ID_LIKE", () => {
    writeFileSync(osReleasePath, 'ID=rocky\nID_LIKE="rhel centos fedora"\n');
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("rpm");
  });

  it("detects openSUSE as rpm", () => {
    writeFileSync(osReleasePath, 'ID=opensuse-leap\nID_LIKE="suse opensuse"\n');
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("rpm");
    expect(info.message).toMatch(/zypper update cadencr/);
    expect(info.message).not.toMatch(/dnf/);
  });

  it("falls back to unknown for distros we don't recognize", () => {
    writeFileSync(osReleasePath, "ID=somethingnew\n");
    const info = detectLinuxInstallType({}, osReleasePath);
    expect(info.type).toBe("unknown");
    expect(info.message).toMatch(/package manager/);
  });

  it("falls back to unknown when /etc/os-release is missing", () => {
    const info = detectLinuxInstallType({}, join(tmpDir, "does-not-exist"));
    expect(info.type).toBe("unknown");
  });
});
