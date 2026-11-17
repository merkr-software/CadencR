// Stop a heavy operation (Rust precompile, build, full test run) before it
// fills the disk. A Cargo build that runs out of space half-way leaves broken
// incremental state and a machine where nothing else can write, and every dev
// database or worktree copy competes for the same space.
//
//   node scripts/disk-space.mjs <operation>   # exits 1 below the threshold
//
// CADENCR_MIN_FREE_DISK_GIB overrides the threshold (0 disables the check).
import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

/** A fresh debug + test + clippy target is ~7.5 GB; keep room for the rest of the machine. */
export const DEFAULT_MIN_FREE_GIB = 10;
const GIB = 1024 ** 3;

/** The threshold in GiB from the environment, or the default. Throws on a malformed value. */
export function minFreeGib(env = process.env) {
  const raw = env.CADENCR_MIN_FREE_DISK_GIB;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_FREE_GIB;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`CADENCR_MIN_FREE_DISK_GIB must be a number of GiB ≥ 0, got "${raw}"`);
  }
  return value;
}

/** Why `operation` must not start with `freeBytes` available, or null. Pure. */
export function diskSpaceProblem({ operation, path, freeBytes, minGib }) {
  if (minGib === 0 || freeBytes >= minGib * GIB) return null;
  const free = (freeBytes / GIB).toFixed(1);
  return [
    `${operation}: only ${free} GiB free on the volume holding ${path}; it needs at least ${minGib} GiB.`,
    "Free space first: `pnpm rust:storage` lists Cargo targets, dev databases and backups,",
    "`pnpm rust:prune -- --apply` removes stale worktree targets, `pnpm rust:clean -- --apply` this one.",
    "Override with CADENCR_MIN_FREE_DISK_GIB=<GiB> (0 disables the check).",
  ].join("\n");
}

/** Bytes an unprivileged process can still write on the volume holding `path`. */
export function freeBytesAt(path) {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}

/** Throw a clear error when the volume holding `path` is below the threshold. */
export function requireDiskSpace(operation, { path = repoRoot, env = process.env } = {}) {
  const problem = diskSpaceProblem({
    operation,
    path,
    freeBytes: freeBytesAt(path),
    minGib: minFreeGib(env),
  });
  if (problem) throw new Error(problem);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const operation = process.argv[2] ?? "this operation";
  try {
    requireDiskSpace(operation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
