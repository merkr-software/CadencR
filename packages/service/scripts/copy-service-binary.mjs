import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv[2] ?? "release";
if (!["debug", "release", "local"].includes(profile)) {
  throw new Error(`Unsupported service build profile: ${profile}`);
}
const exe = process.platform === "win32" ? ".exe" : "";
const targetDir = process.env.CARGO_TARGET_DIR || join("..", "..", "target");
const source = join(targetDir, profile, `cadencr-service${exe}`);
const electronDir = join("..", "desktop", "resources", "bin");
const binaryName = `cadencr-service${exe}`;

// The flat copy feeds local tooling (smoke test, runtime-deps check); the
// per-arch copy is what electron-builder packages (`resources/bin/${arch}`).
// Node's `process.arch` names (x64, arm64) match electron-builder's.
for (const dir of [electronDir, join(electronDir, process.arch)]) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, join(dir, binaryName));
}
