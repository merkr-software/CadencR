import { describe, expect, it } from "vitest";
import { assertElectronBundleContract, type ElectronBundleContract } from "./bundle-contract";

const mainContract: ElectronBundleContract = {
  processName: "main",
  entryFileName: "index.js",
  externalizationSentinels: ["electron", "electron-updater", "dotenv"],
};

function validBundle() {
  return {
    "index.js": {
      type: "chunk",
      isEntry: true,
      imports: ["electron", "electron-updater", "dotenv"],
    },
  };
}

describe("assertElectronBundleContract", () => {
  it("accepts a CommonJS entry with externalized runtime dependencies", () => {
    expect(() => assertElectronBundleContract(mainContract, "cjs", validBundle())).not.toThrow();
  });

  it("rejects an ESM output format", () => {
    expect(() => assertElectronBundleContract(mainContract, "es", validBundle())).toThrow(
      "Electron main build must use CommonJS",
    );
  });

  it("rejects a renamed entry file", () => {
    expect(() =>
      assertElectronBundleContract(mainContract, "cjs", {
        "index.mjs": validBundle()["index.js"],
      }),
    ).toThrow("Electron main build did not produce the required entry: index.js");
  });

  it("rejects a bundled runtime dependency", () => {
    const bundle = validBundle();
    bundle["index.js"].imports = ["electron", "dotenv"];

    expect(() => assertElectronBundleContract(mainContract, "cjs", bundle)).toThrow(
      "Electron main bundle did not keep electron-updater external",
    );
  });

  describe("sandboxed preload entries", () => {
    const preloadContract: ElectronBundleContract = {
      processName: "preload",
      entryFileName: "index.js",
      externalizationSentinels: ["electron"],
      sandboxedEntryFileNames: ["plugin-tab.js"],
    };

    function preloadBundle(guestImports: string[]) {
      return {
        "index.js": { type: "chunk", isEntry: true, imports: ["electron", "chunk-shared.js"] },
        "plugin-tab.js": { type: "chunk", isEntry: true, imports: guestImports },
      };
    }

    it("accepts a sandboxed entry that only requires electron", () => {
      expect(() =>
        assertElectronBundleContract(preloadContract, "cjs", preloadBundle(["electron"])),
      ).not.toThrow();
    });

    it("rejects a sandboxed entry that imports a shared chunk", () => {
      expect(() =>
        assertElectronBundleContract(
          preloadContract,
          "cjs",
          preloadBundle(["electron", "chunk-shared.js"]),
        ),
      ).toThrow("Sandboxed preload entry plugin-tab.js imports chunk-shared.js");
    });

    it("rejects a missing sandboxed entry", () => {
      const bundle: Record<string, { type: string; isEntry?: boolean; imports?: string[] }> =
        preloadBundle(["electron"]);
      delete bundle["plugin-tab.js"];
      expect(() => assertElectronBundleContract(preloadContract, "cjs", bundle)).toThrow(
        "did not produce the required entry: plugin-tab.js",
      );
    });
  });
});
