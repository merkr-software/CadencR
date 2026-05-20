import { describe, expect, it } from "vitest";
import { DOWNLOAD_ASSETS, selectRecommendedDownload } from "./downloads";

describe("selectRecommendedDownload", () => {
  it("recommends the Apple Silicon DMG for macOS arm browsers", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "arm64" });

    expect(result?.assetName).toBe("Cadencr-0.2.0-arm64.dmg");
  });

  it("recommends the Intel DMG for macOS x64 browsers", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "x64" });

    expect(result?.assetName).toBe("Cadencr-0.2.0.dmg");
  });

  it("falls back to the universal macOS recommendation when the arch is unknown", () => {
    const result = selectRecommendedDownload({ os: "macos", arch: "unknown" });

    expect(result?.assetName).toBe("Cadencr-0.2.0.dmg");
  });

  it("does not recommend a download for operating systems not shipped yet", () => {
    expect(selectRecommendedDownload({ os: "linux", arch: "x64" })).toBeUndefined();
    expect(selectRecommendedDownload({ os: "windows", arch: "x64" })).toBeUndefined();
  });

  it("keeps asset URLs pinned to the current landing version", () => {
    expect(DOWNLOAD_ASSETS.every((asset) => asset.url.includes("/v0.2.0/"))).toBe(true);
  });
});
