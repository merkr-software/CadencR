import { describe, expect, it } from "vitest";
import landingPackage from "../../package.json";
import {
  archFromRenderer,
  DOWNLOAD_ASSETS,
  normalizeArch,
  resolveMacArch,
  selectRecommendedDownload,
} from "./downloads";

const appVersion: string = landingPackage.version;

describe("selectRecommendedDownload", () => {
  it("recommends the Apple Silicon DMG for macOS arm browsers", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "arm64" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}-arm64.dmg`);
  });

  it("recommends the Intel DMG for macOS x64 browsers", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "x64" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}.dmg`);
  });

  it("defaults to Apple Silicon when the arch is unknown", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "unknown" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}-arm64.dmg`);
  });

  it("recommends the portable AppImage for Linux x64 browsers", () => {
    const result = selectRecommendedDownload({ os: "linux", arch: "x64" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}.AppImage`);
  });

  it("defaults Linux browsers with an unknown architecture to the x64 AppImage", () => {
    const result = selectRecommendedDownload({ os: "linux", arch: "unknown" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}.AppImage`);
  });

  it("does not recommend the x64 Linux build to ARM browsers", () => {
    expect(selectRecommendedDownload({ os: "linux", arch: "arm64" })).toBeUndefined();
  });

  it("does not recommend a download for operating systems not shipped yet", () => {
    expect(selectRecommendedDownload({ os: "windows", arch: "x64" })).toBeUndefined();
  });

  it("keeps asset URLs pinned to the current landing version", () => {
    expect(DOWNLOAD_ASSETS.every((asset) => asset.url.includes(`/v${appVersion}/`))).toBe(true);
  });

  it("publishes AppImage, DEB, and RPM Linux targets", () => {
    const linuxNames = DOWNLOAD_ASSETS.filter((asset) => asset.os === "linux").map(
      (asset) => asset.assetName,
    );

    expect(linuxNames).toEqual([
      `Cadencr-${appVersion}.AppImage`,
      `Cadencr-${appVersion}-amd64.deb`,
      `Cadencr-${appVersion}-x86_64.rpm`,
    ]);
  });
});

describe("normalizeArch", () => {
  it("maps arm/aarch64 tokens to arm64", () => {
    expect(normalizeArch("arm")).toBe("arm64");
    expect(normalizeArch("arm64")).toBe("arm64");
    expect(normalizeArch("aarch64")).toBe("arm64");
  });

  it("maps x86/x64/intel tokens to x64", () => {
    expect(normalizeArch("x86")).toBe("x64");
    expect(normalizeArch("x86_64")).toBe("x64");
    expect(normalizeArch("Intel")).toBe("x64");
  });

  it("returns unknown for anything else", () => {
    expect(normalizeArch("")).toBe("unknown");
    expect(normalizeArch("mips")).toBe("unknown");
  });
});

describe("archFromRenderer", () => {
  it("reads Apple Silicon from an Apple GPU string (Safari/Firefox)", () => {
    expect(archFromRenderer("Apple GPU")).toBe("arm64");
    expect(archFromRenderer("Apple M3")).toBe("arm64");
    expect(archFromRenderer("ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified)")).toBe(
      "arm64",
    );
  });

  it("reads Intel Macs from Intel/AMD/Radeon GPU strings", () => {
    expect(archFromRenderer("Intel(R) Iris(TM) Plus Graphics")).toBe("x64");
    expect(archFromRenderer("AMD Radeon Pro 5500M")).toBe("x64");
  });

  it("returns unknown for a masked or empty renderer", () => {
    expect(archFromRenderer("")).toBe("unknown");
  });
});

describe("resolveMacArch", () => {
  it("prefers the GPU renderer when definitive (survives Rosetta)", () => {
    // Chromium under Rosetta mislabels the CPU as x86, but Metal still reports
    // the physical Apple GPU — the renderer must win.
    expect(resolveMacArch({ renderer: "arm64", userAgentData: "x64" })).toBe("arm64");
  });

  it("falls back to userAgentData when the renderer is unknown", () => {
    expect(resolveMacArch({ renderer: "unknown", userAgentData: "arm64" })).toBe("arm64");
    expect(resolveMacArch({ renderer: "unknown", userAgentData: "x64" })).toBe("x64");
  });

  it("stays unknown when no signal is definitive (caller defaults to arm64)", () => {
    expect(resolveMacArch({ renderer: "unknown", userAgentData: "unknown" })).toBe("unknown");
  });
});
