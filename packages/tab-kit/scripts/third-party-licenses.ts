import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import type { Plugin } from "vite";

import { packageDir } from "./package-dir.mjs";

/** Packages copied into dist/ by scripts/build.mjs rather than bundled. */
const COPIED_PACKAGES = ["tw-animate-css", "@fontsource-variable/inter"];

function packageRoot(file: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const at = file.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = file.slice(at + marker.length).split(sep);
  const depth = rest[0]?.startsWith("@") ? 2 : 1;
  return file.slice(0, at + marker.length) + rest.slice(0, depth).join(sep);
}

function notice(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license?: string;
    author?: string | { name?: string };
    repository?: string | { url?: string };
  };
  const heading = `## ${pkg.name}@${pkg.version} (${pkg.license ?? "license not declared"})`;
  const licenseFile = readdirSync(root).find((file) => /^licen[cs]e(\.(md|txt))?$/i.test(file));
  if (licenseFile) {
    return `${heading}\n\n${readFileSync(join(root, licenseFile), "utf8").trim()}\n`;
  }
  // Some packages declare their license only in package.json.
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return `${heading}\n\nNo license text shipped. Author: ${author ?? "unknown"}. Source: ${repository ?? "unknown"}.\n`;
}

/** Writes dist/THIRD_PARTY_LICENSES.txt with the license of every package
 *  bundled into (or copied beside) the kit's output. */
export function thirdPartyLicenses(): Plugin {
  return {
    name: "cadencr-third-party-licenses",
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      for (const name of COPIED_PACKAGES) roots.add(packageDir(name, __dirname));
      const notices = [...roots].sort().map(notice);
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.txt",
        source: `Third-party software bundled in @cadencr/tab-kit\n\n${notices.join("\n")}`,
      });
    },
  };
}
