#!/usr/bin/env node
// Builds the release sidecar(s) packaged for the host OS into
// `packages/desktop/resources/bin/<arch>/`: both macOS arches on macOS (see
// build-macos-sidecars.mjs), the host arch on Linux.
import { spawnSync } from "node:child_process";
import path from "node:path";

const serviceDir = path.resolve(import.meta.dirname, "..");

const command = sidecarBuildCommand(process.platform);
if (!command) {
  console.error(`Packaged sidecars are not supported on ${process.platform}.`);
  process.exit(1);
}
const result = spawnSync(command[0], command.slice(1), { cwd: serviceDir, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

function sidecarBuildCommand(platform) {
  if (platform === "darwin") return ["node", path.join("scripts", "build-macos-sidecars.mjs")];
  // `pnpm build` = release build + per-arch copy (copy-service-binary.mjs).
  if (platform === "linux") return ["pnpm", "run", "build"];
  return null;
}
