import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
export const CARGO_LAST_USED_FILE = ".cadencr-last-used";

export function createCargoEnv(baseEnv, options = {}) {
  const env = { ...baseEnv };
  const root = options.repoRoot ?? repoRoot;

  // Cargo artifacts are intentionally isolated per Git worktree. Let Cargo's
  // own incremental compilation optimize repeated builds inside that worktree.
  env.CARGO_TARGET_DIR = join(root, "target");

  let removedSccache = false;
  for (const key of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) {
    if (!usesSccache(env[key])) continue;
    delete env[key];
    removedSccache = true;
  }
  if (removedSccache) {
    delete env.CARGO_INCREMENTAL;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("SCCACHE_")) delete env[key];
  }

  return env;
}

export function markCargoUse(targetDir) {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, CARGO_LAST_USED_FILE), "");
}

function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (args[0] === "--") args.shift();

  if (!command) {
    console.error("Usage: node scripts/cargo-env.mjs <command> [...args]");
    process.exit(1);
  }

  const env = createCargoEnv(process.env);
  markCargoUse(env.CARGO_TARGET_DIR);

  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

export function usesSccache(wrapper) {
  return wrapper !== undefined && basename(wrapper).replace(/\.exe$/i, "") === "sccache";
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
