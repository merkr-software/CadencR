import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import type { Plugin } from "vite";

export function rendererBuildInfo(version: string): {
  buildId: string;
  plugin: Plugin;
} {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const buildId = `${commit.slice(0, 12)}-${process.platform}-${randomUUID()}`;
  return {
    buildId,
    plugin: {
      name: "cadencr-renderer-build-info",
      configResolved(config) {
        if (config.command !== "build" || !config.publicDir) return;
        let entries: string[];
        try {
          entries = readdirSync(config.publicDir);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
          throw error;
        }
        if (entries.some((name) => name.startsWith("react-depth-probe-"))) {
          throw new Error(
            "Move react-depth-probe-* outside public/ before building: diagnostic probes must not ship in the application.",
          );
        }
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: JSON.stringify(
            {
              schemaVersion: 1,
              buildId,
              commit,
              version,
              platform: process.platform,
              node: process.version,
            },
            null,
            2,
          ),
        });
      },
    },
  };
}
