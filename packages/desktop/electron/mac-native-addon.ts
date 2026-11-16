import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Compiles `native/mac-window.m` with the system clang into
 * `resources/native/mac-window.node`, which `electron/main/mac-window.ts` loads
 * and electron-builder ships. One universal binary serves both the arm64 and
 * x64 packages, and Node-API resolves its symbols at load time. Built once per
 * build process (so a flag change lands on the next `pnpm dev`) and again
 * whenever the source changes under the dev watcher.
 */
export function macNativeAddonPlugin(root: string): Plugin {
  const source = path.join(root, "native", "mac-window.m");
  const output = path.join(root, "resources", "native", "mac-window.node");
  let builtFrom: number | null = null;
  return {
    name: "cadencr-mac-native-addon",
    buildStart() {
      if (process.platform !== "darwin") return;
      this.addWatchFile(source);
      const sourceMtime = fs.statSync(source).mtimeMs;
      if (builtFrom === sourceMtime) return;
      fs.mkdirSync(path.dirname(output), { recursive: true });
      // A failed compile throws, failing the build instead of shipping a stale addon.
      execFileSync(
        "clang",
        [
          "-bundle",
          "-undefined",
          "dynamic_lookup",
          "-fobjc-arc",
          "-O2",
          "-arch",
          "arm64",
          "-arch",
          "x86_64",
          "-mmacosx-version-min=12.0",
          "-framework",
          "AppKit",
          source,
          "-o",
          output,
        ],
        { stdio: "inherit" },
      );
      builtFrom = sourceMtime;
    },
  };
}
