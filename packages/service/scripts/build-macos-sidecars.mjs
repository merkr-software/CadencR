#!/usr/bin/env node
// Builds one cadencr-service per macOS architecture into
// `packages/desktop/resources/bin/<arch>/`, where electron-builder.yml's
// `extraResources` picks the one matching the package being built.
import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createCargoEnv, markCargoUse } from "../../../scripts/cargo-env.mjs";

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
for (const triple of triples) {
  run("cargo", ["build", "--locked", "--release", "--bin", "cadencr-service", "--target", triple]);
}

for (const [arch, triple] of Object.entries(TARGETS)) {
  const destination = path.join(binDir, arch, "cadencr-service");
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(env.CARGO_TARGET_DIR, triple, "release", "cadencr-service"), destination);
  run("node", [path.join(serviceDir, "scripts", "check-macos-runtime-deps.mjs"), destination]);
  console.log(`Built ${arch} sidecar: ${destination}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: serviceDir, env, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
