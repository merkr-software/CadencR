#!/usr/bin/env node
// Builds one cadencr-service and one `cadencr` CLI per macOS architecture into
// `packages/desktop/resources/bin/<arch>/`, where electron-builder.yml's
// `extraResources` picks the ones matching the package being built.
import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createCargoEnv, markCargoUse } from "../../../scripts/cargo-env.mjs";
import { bundledCliBuild, desktopAppVersion } from "./build-bundled-cli.mjs";

const serviceDir = path.resolve(import.meta.dirname, "..");
const binDir = path.resolve(serviceDir, "..", "desktop", "resources", "bin");

// electron-builder `${arch}` → Rust target triple.
const TARGETS = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" };

if (process.platform !== "darwin") {
  console.error("macOS sidecars must be built on macOS.");
  process.exit(1);
}

const env = createCargoEnv(process.env);
markCargoUse(env.CARGO_TARGET_DIR);
const triples = Object.values(TARGETS);

run("rustup", ["target", "add", ...triples]);
// One target per cargo run keeps a single release LTO link in memory at a time
// on the ~7 GB CI runner.
const appVersion = desktopAppVersion();
const cliBuilds = Object.fromEntries(
  triples.map((target) => [target, bundledCliBuild({ profile: "release", target, appVersion })]),
);
for (const triple of triples) {
  run("cargo", ["build", "--locked", "--release", "--bin", "cadencr-service", "--target", triple]);
  run("cargo", cliBuilds[triple].args, cliBuilds[triple].env);
}

for (const [arch, triple] of Object.entries(TARGETS)) {
  const destination = path.join(binDir, arch, "cadencr-service");
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(env.CARGO_TARGET_DIR, triple, "release", "cadencr-service"), destination);
  run("node", [path.join(serviceDir, "scripts", "check-macos-runtime-deps.mjs"), destination]);
  console.log(`Built ${arch} sidecar: ${destination}`);
  const cli = path.join(binDir, arch, "cadencr");
  copyFileSync(cliBuilds[triple].output(env.CARGO_TARGET_DIR), cli);
  run("node", [path.join(serviceDir, "scripts", "check-macos-runtime-deps.mjs"), cli]);
  console.log(`Built ${arch} cadencr CLI: ${cli}`);
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: serviceDir,
    env: { ...env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
