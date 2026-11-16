import { describe, expect, it } from "vitest";
import landingPackage from "../../package.json";
import {
  archFromRenderer,
  DOWNLOAD_ASSETS,
  LINUX_ALPHA_RELEASE,
  LINUX_AVAILABLE,
  linuxReleaseAssets,
  macReleaseAssetName,
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

    expect(result?.assetName).toBe(macReleaseAssetName(appVersion, "x64", "installer"));
  });

  it("defaults to Apple Silicon when the arch is unknown", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "unknown" });

    expect(result?.assetName).toBe(`Cadencr-${appVersion}-arm64.dmg`);
  });

  it("recommends the x64 AppImage to Linux browsers once the Linux alpha has shipped", () => {
    const expected = LINUX_AVAILABLE ? `Cadencr-${LINUX_ALPHA_RELEASE}-x86_64.AppImage` : undefined;

    expect(selectRecommendedDownload({ os: "linux", arch: "x64" })?.assetName).toBe(expected);
    expect(selectRecommendedDownload({ os: "linux", arch: "unknown" })?.assetName).toBe(expected);
  });

  it("does not recommend the x64 Linux build to ARM browsers", () => {
    expect(selectRecommendedDownload({ os: "linux", arch: "arm64" })).toBeUndefined();
  });

  it("does not recommend a download for operating systems not shipped yet", () => {
    expect(selectRecommendedDownload({ os: "windows", arch: "x64" })).toBeUndefined();
  });

  it("keeps macOS asset URLs pinned to the current landing version", () => {
    const macAssets = DOWNLOAD_ASSETS.filter((asset) => asset.os === "macos");
    expect(macAssets).toHaveLength(4);
    expect(macAssets.every((asset) => asset.url.includes(`/v${appVersion}/`))).toBe(true);
  });

  it("lists exactly the Linux targets of the release carrying the alpha", () => {
    expect(LINUX_AVAILABLE).toBe(LINUX_ALPHA_RELEASE !== null);
    expect(DOWNLOAD_ASSETS.filter((asset) => asset.os === "linux")).toEqual(
      linuxReleaseAssets(LINUX_ALPHA_RELEASE),
    );
  });
});

describe("macReleaseAssetName", () => {
  it("names both architectures explicitly after v0.13.0", () => {
    expect(macReleaseAssetName("0.14.0", "x64", "installer")).toBe("Cadencr-0.14.0-x64.dmg");
    expect(macReleaseAssetName("0.14.0", "x64", "archive")).toBe("Cadencr-0.14.0-x64-mac.zip");
    expect(macReleaseAssetName("0.14.0", "arm64", "installer")).toBe("Cadencr-0.14.0-arm64.dmg");
    expect(macReleaseAssetName("0.14.0", "arm64", "archive")).toBe("Cadencr-0.14.0-arm64-mac.zip");
  });

  it("keeps the unsuffixed Intel names of v0.13.0", () => {
    expect(macReleaseAssetName("0.13.0", "x64", "installer")).toBe("Cadencr-0.13.0.dmg");
    expect(macReleaseAssetName("0.13.0", "x64", "archive")).toBe("Cadencr-0.13.0-mac.zip");
    expect(macReleaseAssetName("0.13.0", "arm64", "installer")).toBe("Cadencr-0.13.0-arm64.dmg");
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

describe("linuxReleaseAssets", () => {
  it("links no Linux assets while no release carries the alpha", () => {
    expect(linuxReleaseAssets(null)).toEqual([]);
  });

  it("links the arch-named targets of the release carrying the alpha", () => {
    for (const version of ["0.15.0", "0.15.2", "1.0.0"]) {
      expect(linuxReleaseAssets(version).map((asset) => asset.assetName)).toEqual([
        `Cadencr-${version}-x86_64.AppImage`,
        `Cadencr-${version}-amd64.deb`,
        `Cadencr-${version}-x86_64.rpm`,
      ]);
      expect(
        linuxReleaseAssets(version).every((asset) => asset.url.includes(`/v${version}/`)),
      ).toBe(true);
    }
  });
});
