#!/usr/bin/env node
// Builds the `cadencr` command line the desktop app ships next to its sidecar
// (`Resources/bin/cadencr` in the package) into
// `packages/desktop/resources/bin/<arch>/cadencr`.
//
//   node scripts/build-bundled-cli.mjs <release|local>
//
// builds for the host. `build-macos-sidecars.mjs` reuses `bundledCliBuild` for
// both macOS arches. The CLI bakes the app version in at compile time
// (CADENCR_APP_VERSION) to hand it to the service in `cadencr serve`.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCargoEnv, markCargoUse } from "../../../scripts/cargo-env.mjs";

const serviceDir = path.resolve(import.meta.dirname, "..");
const desktopDir = path.resolve(serviceDir, "..", "desktop");
export const BUNDLED_BIN_DIR = path.join(desktopDir, "resources", "bin");

/** The desktop app's version: the one the bundled CLI reports to the service. */
export function desktopAppVersion() {
  const manifest = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  if (typeof manifest.version !== "string") throw new Error("packages/desktop has no version");
  return manifest.version;
}

/**
 * The cargo invocation for one bundled CLI build. `profile` is a Cargo
 * profile name; `target` an optional Rust triple (cross builds).
 */
export function bundledCliBuild({ profile, target, appVersion }) {
  const args = ["build", "--locked", "--profile", profile, "-p", "cadencr-cli", "--bin", "cadencr"];
  if (target) args.push("--target", target);
  // Cargo names the `dev` profile's output directory `debug`.
  const profileDir = profile === "dev" ? "debug" : profile;
  return {
    args,
    env: { CADENCR_APP_VERSION: appVersion },
    output: (targetDir) =>
      target
        ? path.join(targetDir, target, profileDir, "cadencr")
        : path.join(targetDir, profileDir, "cadencr"),
  };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: serviceDir, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const profile = process.argv[2] ?? "release";
  if (!["release", "local"].includes(profile)) {
    console.error(`Unsupported bundled CLI profile: ${profile}`);
    process.exit(1);
  }
  const env = createCargoEnv(process.env);
  markCargoUse(env.CARGO_TARGET_DIR);
  const build = bundledCliBuild({ profile, appVersion: desktopAppVersion() });
  run("cargo", build.args, { ...env, ...build.env });
  const source = build.output(env.CARGO_TARGET_DIR);
  // The flat copy mirrors the sidecar's (local tooling); electron-builder
  // packages the per-arch one. Node's arch names match electron-builder's.
  for (const dir of [BUNDLED_BIN_DIR, path.join(BUNDLED_BIN_DIR, process.arch)]) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(source, path.join(dir, "cadencr"));
  }
  run("node", [path.join(serviceDir, "scripts", "check-macos-runtime-deps.mjs"), source], env);
  console.log(`Built bundled cadencr CLI: ${path.join(BUNDLED_BIN_DIR, process.arch, "cadencr")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
