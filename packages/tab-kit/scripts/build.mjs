#!/usr/bin/env node
// Builds dist/:
//   index.js                 desktop UI components (vite library mode)
//   types/                   declarations, `@/` aliases rewritten to relative paths
//   fonts/                   Inter woff2 + OFL, referenced by fonts.css
//   tw-animate.css           the animation utilities the components use
//   THIRD_PARTY_LICENSES.txt every bundled/copied package's license
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewriteDeclarations } from "./declarations.mjs";
import { packageDir as findPackageDir } from "./package-dir.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const packageDir = (name) => findPackageDir(name, root);

rmSync(dist, { recursive: true, force: true });
run(join(packageDir("vite"), "bin/vite.js"), ["build", "--logLevel", "warn"]);
run(join(packageDir("typescript"), "bin/tsc"), ["-p", "tsconfig.build.json"]);
rewriteDeclarations(join(dist, ".types-raw"), join(dist, "types"));
rmSync(join(dist, ".types-raw"), { recursive: true, force: true });

// Every font file fonts.css points at, plus the font's license.
const interDir = packageDir("@fontsource-variable/inter");
mkdirSync(join(dist, "fonts"), { recursive: true });
const fontsCss = readFileSync(join(root, "fonts.css"), "utf8");
for (const [, file] of fontsCss.matchAll(/url\("\.\/dist\/fonts\/([^"]+)"\)/g)) {
  cpSync(join(interDir, "files", file), join(dist, "fonts", file));
}
cpSync(join(interDir, "LICENSE"), join(dist, "fonts", "OFL.txt"));
cpSync(join(packageDir("tw-animate-css"), "dist/tw-animate.css"), join(dist, "tw-animate.css"));
