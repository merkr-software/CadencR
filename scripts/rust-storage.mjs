import { existsSync, lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARGO_LAST_USED_FILE, createCargoEnv } from "./cargo-env.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

export function parseWorktreeList(output) {
  return output
    .split("\0\0")
    .map((record) => record.split("\0").find((field) => field.startsWith("worktree ")))
    .filter(Boolean)
    .map((field) => field.slice("worktree ".length));
}

export function parseAge(value) {
  const match = /^(\d+)([dh])$/.exec(value);
  if (!match) throw new Error(`Invalid age "${value}". Use a value such as 14d or 24h.`);
  const unitMs = match[2] === "d" ? 86_400_000 : 3_600_000;
  return Number(match[1]) * unitMs;
}

export function selectPruneCandidates(entries, currentRoot, mainRoot, cutoffMs) {
  const excluded = new Set([resolve(currentRoot), resolve(mainRoot)]);
  return entries.filter(
    (entry) =>
      entry.exists &&
      !entry.isSymlink &&
      entry.lastUsedMs < cutoffMs &&
      !excluded.has(resolve(entry.worktree)),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "pipe",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
}

function listWorktrees() {
  return parseWorktreeList(run("git", ["worktree", "list", "--porcelain", "-z"]));
}

function mainCheckoutRoot() {
  const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  return dirname(commonDir);
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readdirIfExists(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function collectDirectoryStats(root) {
  const rootStat = lstatIfExists(root);
  if (!rootStat) return { exists: false, isSymlink: false, size: 0, lastUsedMs: 0 };
  if (rootStat.isSymbolicLink()) {
    return { exists: true, isSymlink: true, size: 0, lastUsedMs: rootStat.mtimeMs };
  }

  let size = 0;
  let latestMtimeMs = rootStat.mtimeMs;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirIfExists(directory)) {
      const path = join(directory, entry.name);
      const stat = lstatIfExists(path);
      if (!stat) continue;
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stat.isSymbolicLink()) size += stat.size;
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
    }
  }
  const markerStat = lstatIfExists(join(root, CARGO_LAST_USED_FILE));
  return {
    exists: true,
    isSymlink: false,
    size,
    lastUsedMs: markerStat?.mtimeMs ?? latestMtimeMs,
  };
}

function targetEntries() {
  return listWorktrees().map((worktree) => ({
    worktree,
    target: join(worktree, "target"),
    ...collectDirectoryStats(join(worktree, "target")),
  }));
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit >= 3 ? 2 : 0)} ${units[unit]}`;
}

function printTargets(entries) {
  const existing = entries.filter((entry) => entry.exists);
  if (existing.length === 0) {
    console.log("No worktree target directories found.");
    return;
  }
  for (const entry of existing) {
    const warning = entry.isSymlink ? " [symlink: cleanup disabled]" : "";
    console.log(`${formatBytes(entry.size).padStart(10)}  ${entry.target}${warning}`);
  }
  const total = existing.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`${formatBytes(total).padStart(10)}  total Cargo targets`);
}

function status() {
  console.log("Cargo targets (one per worktree):");
  printTargets(targetEntries());

  const legacy = join(mainCheckoutRoot(), ".shared-cargo-target");
  console.log(`\nLegacy shared target: ${existsSync(legacy) ? `PRESENT at ${legacy}` : "absent"}`);
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

export function parseCleanArgs(args) {
  const options = { apply: false, cargoArgs: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--release") options.cargoArgs.push("--release");
    else if (arg === "--profile") {
      options.cargoArgs.push("--profile", optionValue(args, index, arg));
      index += 1;
    } else throw new Error(`Unsupported clean option: ${arg}`);
  }
  return options;
}

function clean(args) {
  const options = parseCleanArgs(args);
  const cargoArgs = ["clean", ...options.cargoArgs];
  if (!options.apply) cargoArgs.push("--dry-run");
  console.log(
    options.apply ? "Cleaning current worktree target..." : "Dry run; pass --apply to clean.",
  );
  run("cargo", cargoArgs, { stdio: "inherit", env: createCargoEnv(process.env) });
}

export function parsePruneArgs(args) {
  const options = { apply: false, olderThanMs: parseAge("14d") };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--apply") options.apply = true;
    else if (arg === "--older-than") {
      options.olderThanMs = parseAge(optionValue(args, index, arg));
      index += 1;
    } else throw new Error(`Unsupported prune option: ${arg}`);
  }
  return options;
}

function assertSafeTarget(entry) {
  const target = join(entry.worktree, "target");
  const targetStat = lstatIfExists(target);
  if (!targetStat) throw new Error(`Target disappeared before cleanup: ${target}`);
  if (targetStat.isSymbolicLink()) throw new Error(`Refusing symlink target: ${target}`);
  if (!targetStat.isDirectory()) throw new Error(`Target is not a directory: ${target}`);
  if (!existsSync(join(entry.worktree, "Cargo.toml"))) {
    throw new Error(`Worktree has no Cargo.toml: ${entry.worktree}`);
  }
}

function prune(args) {
  const options = parsePruneArgs(args);
  const entries = targetEntries();
  const cutoffMs = Date.now() - options.olderThanMs;
  const candidates = selectPruneCandidates(entries, repoRoot, mainCheckoutRoot(), cutoffMs);
  console.log(options.apply ? "Pruning inactive worktree targets:" : "Dry-run prune candidates:");
  printTargets(candidates);
  if (!options.apply || candidates.length === 0) return;

  for (const entry of candidates) {
    assertSafeTarget(entry);
    run("cargo", ["clean", "--manifest-path", join(entry.worktree, "Cargo.toml")], {
      cwd: entry.worktree,
      stdio: "inherit",
      env: createCargoEnv(process.env, { repoRoot: entry.worktree }),
    });
  }
}

function main() {
  const command = process.argv[2] ?? "status";
  const args = process.argv.slice(3);
  if (command === "status") status();
  else if (command === "clean") clean(args);
  else if (command === "prune") prune(args);
  else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
