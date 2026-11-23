import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, futimesSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCargoEnv, markCargoUse } from "./cargo-env.mjs";
import { requireDiskSpace } from "./disk-space.mjs";
import { gitCommonDir } from "./git-worktrees.mts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const DEV_PRECOMPILE = "pnpm dev:precompile";
const LOCK_BUSY = 75;

function checkResult(result, command) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} failed (${result.signal ?? `exit ${result.status}`})`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function acquireLock(fd) {
  // Both utilities flock the open description passed as descriptor 3.
  const mac = process.platform === "darwin";
  const command = mac ? "/usr/bin/lockf" : "flock";
  const noWait = mac ? ["-s", "-t", "0"] : ["-n", "-E", String(LOCK_BUSY)];
  const options = { stdio: ["ignore", "inherit", "inherit", fd] };
  const result = spawnSync(command, [...noWait, "3"], options);
  if (!mac && result.error?.code === "ENOENT") {
    throw new Error("Rust precompiles on Linux require `flock` (install `util-linux`).");
  }
  if (result.status !== LOCK_BUSY) return checkResult(result, command);
  console.log("Waiting for the shared Rust precompile slot…");
  checkResult(spawnSync(command, ["3"], options), command);
}

/** One warm-up build per Git repository. Cargo still writes to its checkout's target. */
export function withRustPrecompile(root, operation, build, baseEnv = process.env) {
  const commonDir = realpathSync(gitCommonDir(root));
  const key = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
  // A fixed, user-scoped path also coordinates callers with different TMPDIR settings.
  const lock = join("/tmp", `cadencr-rust-precompile-${process.getuid()}-${key}.lock`);
  // Keep the inode after release so existing waiters and new arrivals always lock the same file.
  const fd = openSync(lock, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid()) {
      throw new Error(`Expected a regular lock file owned by this user at ${lock}`);
    }
    acquireLock(fd);
    // Keep an active lock recent for tools that clean old temporary files.
    const now = new Date();
    futimesSync(fd, now, now);
    requireDiskSpace(operation, { path: root, env: baseEnv });
    const env = createCargoEnv(baseEnv, { repoRoot: root });
    // Cargo inherits the descriptor so cancellation cannot free the slot while it is still running.
    const run = (command, args) => {
      const result = spawnSync(command, args, {
        cwd: root,
        env,
        stdio: command === "cargo" ? ["inherit", "inherit", "inherit", fd] : "inherit",
      });
      checkResult(result, `${command} ${args.join(" ")}`);
    };
    markCargoUse(env.CARGO_TARGET_DIR);
    build(run);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    withRustPrecompile(repoRoot, DEV_PRECOMPILE, (run) => {
      console.log("Precompiling Claude SDK...");
      run("cargo", ["build", "--quiet", "-p", "claude-agent-sdk-rs"]);
      console.log("Precompiling Cadencr service...");
      run("cargo", ["build", "--quiet", "-p", "cadencr-service"]);
      run("pnpm", ["--silent", "--filter", "@cadencr/service", "copy:debug"]);
    });
    console.log("Rust development targets are ready.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
