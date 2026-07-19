import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectLinuxInstallType } from "./linux-install-type";

describe("detectLinuxInstallType", () => {
  let tmpDir: string;
  let packageTypePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cadencr-package-type-"));
    packageTypePath = join(tmpDir, "package-type");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns appimage when the AppImage runtime identifies itself", () => {
    writeFileSync(packageTypePath, "deb\n");
    expect(detectLinuxInstallType({ APPIMAGE: "/tmp/Cadencr.AppImage" }, packageTypePath)).toBe(
      "appimage",
    );
  });

  it("reads deb package identity written by electron-builder", () => {
    writeFileSync(packageTypePath, "deb\n");
    expect(detectLinuxInstallType({}, packageTypePath)).toBe("deb");
  });

  it("reads rpm package identity written by electron-builder", () => {
    writeFileSync(packageTypePath, "RPM\n");
    expect(detectLinuxInstallType({}, packageTypePath)).toBe("rpm");
  });

  it("returns unknown for an unsupported package identity", () => {
    writeFileSync(packageTypePath, "pacman\n");
    expect(detectLinuxInstallType({}, packageTypePath)).toBe("unknown");
  });

  it("returns unknown when the package identity is missing", () => {
    expect(detectLinuxInstallType({}, join(tmpDir, "missing"))).toBe("unknown");
  });

  it("returns unknown without a package identity path", () => {
    expect(detectLinuxInstallType({})).toBe("unknown");
  });
});
