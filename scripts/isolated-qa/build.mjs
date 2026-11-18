// `pnpm qa:build`: the checks and builds a run needs, kept apart from starting
// it so no start-up timeout can ever abandon a compilation in progress.
import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchBuildEnv } from "../build-local.mjs";
import { createCargoEnv } from "../cargo-env.mjs";
import { evaluateForQa, formatReport, gatherFacts } from "../doctor.mjs";
import { withRustPrecompile } from "../precompile-dev.mjs";
import { lsofCommand } from "./processes.mjs";

// A marketplace build has its own target dir: its compile-time catalog pins
// would otherwise invalidate the everyday debug build, and the reverse.
const MARKETPLACE_TARGET = "qa-marketplace";
const TELEMETRY_BUILD_VARIABLES = [
  "CADENCR_SENTRY_DSN",
  "CADENCR_POSTHOG_KEY",
  "CADENCR_POSTHOG_HOST",
];

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(" ")}\` exited with ${result.status}`);
  }
}

/**
 * Check what a run needs, creating what a checkout may legitimately lack: the
 * dev `.env` files of a linked worktree and the Electron binary. Fast; runs
 * before every start, `--skip-build` included.
 */
export function preflight({ repoRoot, surface }) {
  let facts = gatherFacts(repoRoot);
  if ((!facts.env.service || !facts.env.desktop) && facts.linkedWorktree) {
    console.log("No dev .env files yet: running `pnpm dev:configure-worktree`.");
    run("pnpm", ["dev:configure-worktree"], repoRoot);
    facts = gatherFacts(repoRoot);
  }
  if (surface === "electron" && !facts.electron.installed) {
    console.log(
      "Electron binary missing: running `pnpm --filter @cadencr/desktop ensure:electron`.",
    );
    run("pnpm", ["--filter", "@cadencr/desktop", "ensure:electron"], repoRoot);
    facts = gatherFacts(repoRoot);
  }
  const checks = evaluateForQa(facts, { electron: surface === "electron" });
  if (checks.some((check) => check.status === "error")) {
    console.error(formatReport(checks));
    throw new Error("fix the doctor errors above, then rerun");
  }
  // Port ownership checks need lsof; minimal Linux installs lack it.
  if (spawnSync(lsofCommand(), ["-v"], { stdio: "ignore" }).error) {
    throw new Error(
      "lsof is required to verify a run's ports: install it (e.g. `apt install lsof`)",
    );
  }
}

/**
 * Preflight, then build the service the run will use. Cargo may take many
 * minutes on a cold target: nothing here times out, and rerunning resumes.
 */
export function build({ repoRoot, surface, marketplace }) {
  preflight({ repoRoot, surface });
  if (marketplace) buildMarketplaceService(repoRoot);
  else run("pnpm", ["dev:precompile"], repoRoot);
}

/**
 * The marketplace catalog, trust pins and blocklists are compile-time values
 * (the repository's public build variables, as `pnpm build:local` uses). A
 * QA build gets them without telemetry endpoints: a QA run reports nothing.
 */
function buildMarketplaceService(repoRoot) {
  const { env, configured } = fetchBuildEnv();
  if (!configured) {
    throw new Error("marketplace build variables are unavailable (needs `gh` access)");
  }
  for (const name of TELEMETRY_BUILD_VARIABLES) delete env[name];
  const targetDir = join(cargoTarget(repoRoot), MARKETPLACE_TARGET);
  withRustPrecompile(
    repoRoot,
    "pnpm qa:build --marketplace",
    (run) => {
      run("cargo", ["build", "--quiet", "-p", "cadencr-service", "--target-dir", targetDir]);
    },
    env,
  );
}

function cargoTarget(repoRoot) {
  return createCargoEnv(process.env, { repoRoot }).CARGO_TARGET_DIR;
}

export function serviceBinary(repoRoot, { marketplace = false } = {}) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const target = cargoTarget(repoRoot);
  const dir = marketplace ? join(target, MARKETPLACE_TARGET) : target;
  return join(dir, "debug", `cadencr-service${exe}`);
}

/**
 * The service binary a run will copy, or an error naming the build to run.
 * Checked before a run directory exists, so `--skip-build` without a build
 * leaves nothing behind.
 */
export function requireServiceBinary(repoRoot, { marketplace = false } = {}, exists = existsSync) {
  const binary = serviceBinary(repoRoot, { marketplace });
  if (exists(binary)) return binary;
  const command = marketplace ? "pnpm qa:build --marketplace" : "pnpm qa:build";
  throw new Error(`no service binary at ${binary}: run \`${command}\` first`);
}

/**
 * The run gets its own copy of the binary: a rebuild cannot swap it under a
 * running service, and its path identifies the run's processes. APFS clones
 * (`cp -c`) and Linux reflinks make the copy free where the filesystem can.
 */
export function copyServiceBinary(source, target) {
  if (process.platform === "darwin" && spawnSync("cp", ["-c", source, target]).status === 0) return;
  copyFileSync(source, target, constants.COPYFILE_FICLONE);
}
