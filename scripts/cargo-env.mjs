import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
export const CARGO_LAST_USED_FILE = ".cadencr-last-used";

/**
 * libtest runs one test per CPU. Many of our tests spawn processes and bound
 * how long a child may take, so on a machine other sessions already load a
 * full-width suite starves its own children. The default keeps every CPU while
 * they are idle and drops to half of them (at least four, libtest's own default
 * on a 4-CPU CI runner) as the load average takes them. Measured on a 14-core
 * Mac: 14 threads ran the service suite in 114 s idle against 192 s with 7,
 * while under a load average of 70+ a 14-thread run passed 30 minutes.
 */
export function defaultRustTestThreads({
  cpus = availableParallelism(),
  load = loadavg()[0],
} = {}) {
  const floor = Math.max(Math.min(cpus, 4), Math.floor(cpus / 2));
  return Math.max(floor, Math.min(cpus, Math.floor(cpus - load)));
}

/** The thread count Cargo test runs get, and where it comes from. */
export function rustTestThreads(env, machine) {
  return env.RUST_TEST_THREADS
    ? { value: env.RUST_TEST_THREADS, source: "RUST_TEST_THREADS" }
    : { value: String(defaultRustTestThreads(machine)), source: "machine default" };
}

export function createCargoEnv(baseEnv, options = {}) {
  const env = { ...baseEnv };
  const root = options.repoRoot ?? repoRoot;
  env.RUST_TEST_THREADS = rustTestThreads(env, options.machine).value;

  // Keep artifacts isolated per worktree without accumulating incremental caches.
  env.CARGO_TARGET_DIR = join(root, "target");
  env.CARGO_INCREMENTAL = "0";

  for (const key of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) {
    if (!usesSccache(env[key])) continue;
    delete env[key];
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
