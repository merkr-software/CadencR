#!/usr/bin/env node
// Builds dist/: ESM + .d.ts emitted by tsc from src/ (tests excluded).
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The vendoring flow builds without running tests, so the build itself guards
// the version sent in `hello` (protocol.test.ts asserts the same at runtime).
const versionSource = readFileSync(join(root, "src/version.ts"), "utf8");
if (!versionSource.includes(`export const SDK_VERSION = "${pkg.version}";`)) {
  console.error(`src/version.ts does not match package.json version ${pkg.version}`);
  process.exit(1);
}

rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
