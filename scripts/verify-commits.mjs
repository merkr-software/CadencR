// Check every commit of a series the way the pre-commit hook would, in a
// temporary detached worktree that is removed afterwards. Your checkout, its
// branch, index and uncommitted edits are never touched.
//
//   node scripts/verify-commits.mjs                 # main..HEAD
//   node scripts/verify-commits.mjs origin/main..HEAD --keep-going
//   node scripts/verify-commits.mjs HEAD~3..HEAD --full
//   node scripts/verify-commits.mjs --dry-run       # list commits and their plans
//
// This checkout's `scripts/pre-commit.mjs` routes the files each commit changed
// (`--full`: the whole workspace check); the steps run in the commit's tree,
// with its own scripts and dependencies. Rust builds go to a target kept for
// these runs under this checkout's `target/verify-commits`: the first run
// builds the dependencies, later ones only what the commits change, and your
// own `target/` artifacts are never touched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDiskSpace } from "./disk-space.mjs";
import { runGit } from "./git-worktrees.mts";
import { listDirOrEmpty } from "./node-requirement.mjs";
import { buildPrecommitPlan, commitEntries, prepareChecks, runPlan } from "./pre-commit.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

const USAGE =
  "usage: node scripts/verify-commits.mjs [<range>] [--full] [--keep-going] [--dry-run]\n" +
  "  <range> defaults to main..HEAD";

/** Exit statuses of a step that Ctrl-C (130) or SIGTERM (143) ended. */
const INTERRUPTED = new Set([130, 143]);

/** Parse the command line. Pure. */
export function parseArgs(argv) {
  const options = { range: "main..HEAD", full: false, keepGoing: false, dryRun: false };
  const flags = { "--full": "full", "--keep-going": "keepGoing", "--dry-run": "dryRun" };
  const positional = [];
  for (const arg of argv) {
    // `pnpm verify:commits -- <range>` passes the separator through.
    if (arg === "--") continue;
    if (flags[arg]) options[flags[arg]] = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new Error(`expected one range, got ${positional.join(" ")}\n${USAGE}`);
  if (positional.length === 1) options.range = positional[0];
  return options;
}

const git = (args, cwd) => runGit(cwd, args).trim();

/** Oldest first, with subjects: `[{ sha, subject }]`. */
export function listCommits(range, cwd = repoRoot) {
  const output = git(["log", "--reverse", "--format=%H%x09%s", range], cwd);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
}

/**
 * One stable path per source checkout: a crashed run is found and cleaned on
 * the next one, and Cargo sees the same workspace path each time.
 */
export function worktreePathFor(root, base = process.env.CADENCR_VERIFY_DIR || tmpdir()) {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 10);
  return join(base, `cadencr-verify-${id}`);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but someone else's; ESRCH: gone.
    return error.code === "EPERM";
  }
};

/** The real path of `path`, resolving the part that still exists when the rest is gone. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    // Gone (or never created): resolve its parent instead.
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? parent : join(realpathOr(parent), basename(path));
  }
}

/**
 * Drop git's record of `checkout` alone, when its directory went missing
 * (`git worktree prune` would also drop the user's other missing worktrees).
 */
function forgetRegistration(root, checkout) {
  const admin = join(resolve(root, git(["rev-parse", "--git-common-dir"], root)), "worktrees");
  for (const name of listDirOrEmpty(admin)) {
    const gitdirFile = join(admin, name, "gitdir");
    if (!existsSync(gitdirFile)) continue;
    const registered = dirname(readFileSync(gitdirFile, "utf8").trim());
    if (realpathOr(registered) === realpathOr(checkout)) {
      rmSync(join(admin, name), { recursive: true, force: true });
    }
  }
}

function removeCheckout(root, checkout) {
  if (existsSync(checkout)) git(["worktree", "remove", "--force", checkout], root);
  forgetRegistration(root, checkout);
}

/** Remove the temporary worktree, its registration and its directory. */
export function removeWorktree(root, path) {
  removeCheckout(root, join(path, "checkout"));
  rmSync(path, { recursive: true, force: true });
}

/** The pid in a lock file; empty while its writer is mid-write, so read again. */
function lockHolder(lock) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid > 0) return pid;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return null;
}

/** Claim `path` for this process (atomically), replacing what a dead run left. */
function claim(root, path) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = join(path, "pid");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      // A run that died before writing its lock may have left its checkout.
      removeCheckout(root, join(path, "checkout"));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = lockHolder(lock);
    if (holder && pidAlive(holder)) {
      throw new Error(`another verification (pid ${holder}) is using ${path}`);
    }
    removeWorktree(root, path);
  }
  throw new Error(`could not claim ${path}`);
}

/** Create the detached worktree at `commit`; refuse while another run holds it. */
export function createWorktree(root, path, commit) {
  claim(root, path);
  const checkout = join(path, "checkout");
  try {
    git(["worktree", "add", "--detach", "--quiet", checkout, commit], root);
  } catch (error) {
    removeWorktree(root, path);
    throw error;
  }
  return checkout;
}

/** `prepare` throws it when a signal ended its work. */
export class Interrupted extends Error {}

/**
 * Check `commits` one after the other in a temporary worktree at `path`.
 * `prepare(checkout, commit, previous)` readies the checkout (deps),
 * `check(checkout, commit)` returns an exit status. A step ended by Ctrl-C or
 * SIGTERM stops the series, `--keep-going` or not. The worktree is removed
 * whatever happens; a run killed outright leaves it for the next run to clean.
 */
export function verifyCommits({
  root,
  commits,
  path,
  keepGoing,
  prepare,
  check,
  log = console.log,
}) {
  const results = [];
  let interrupted = false;
  // Outside the try: a worktree another run holds must not be removed.
  const checkout = createWorktree(root, path, commits[0].sha);
  // Ctrl-C reaches the running step too; staying alive lets the cleanup run.
  const survive = () => {};
  process.on("SIGINT", survive);
  try {
    let previous = null;
    for (const commit of commits) {
      log(`\n### ${commit.sha.slice(0, 10)} ${commit.subject}`);
      git(["checkout", "--detach", "--quiet", commit.sha], checkout);
      const started = Date.now();
      let status;
      try {
        prepare(checkout, commit, previous);
        status = check(checkout, commit);
      } catch (error) {
        if (!(error instanceof Interrupted)) throw error;
        status = 130;
      }
      results.push({ ...commit, status, seconds: Math.round((Date.now() - started) / 1000) });
      previous = commit;
      if (INTERRUPTED.has(status)) {
        interrupted = true;
        break;
      }
      if (status !== 0 && !keepGoing) break;
    }
  } finally {
    process.off("SIGINT", survive);
    removeWorktree(root, path);
  }
  return { results, interrupted };
}

/** The final table: one line per commit, and the ones never reached. Pure. */
export function formatSummary(commits, { results, interrupted }) {
  const byCommit = new Map(results.map((result) => [result.sha, result]));
  const lines = ["", "verify-commits summary:"];
  for (const commit of commits) {
    const result = byCommit.get(commit.sha);
    const state = !result
      ? "skipped"
      : result.status === 0
        ? "ok"
        : INTERRUPTED.has(result.status)
          ? "interrupted"
          : `FAILED (exit ${result.status})`;
    const time = result ? ` ${result.seconds}s` : "";
    lines.push(
      `  ${state.padEnd(16)} ${commit.sha.slice(0, 10)}${time.padEnd(7)} ${commit.subject}`,
    );
  }
  if (interrupted) lines.push("  interrupted: the remaining commits were not checked");
  return lines.join("\n");
}

/** Whether `pnpm-lock.yaml` differs between two commits. */
function lockfileChanged(cwd, from, to) {
  const diff = spawnSync("git", ["diff", "--quiet", from, to, "--", "pnpm-lock.yaml"], { cwd });
  if (diff.status === 0 || diff.status === 1) return diff.status === 1;
  throw new Error(`cannot compare pnpm-lock.yaml between ${from} and ${to}`);
}

/** Point the checkout at the dedicated target, and install dependencies when the lockfile changes. */
function installDependencies(checkout, commit, previous) {
  if (!existsSync(join(checkout, "target"))) {
    // The Cargo wrapper pins `<checkout>/target`. A target shared with this
    // checkout would leave it artifacts built from another commit's sources.
    const target = join(repoRoot, "target", "verify-commits");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(checkout, "target"));
  }
  if (previous && !lockfileChanged(checkout, previous.sha, commit.sha)) return;
  // No lifecycle scripts: husky's `prepare` would rewrite the shared git config.
  const install = spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--reporter=silent"],
    { cwd: checkout, stdio: "inherit" },
  );
  if (install.signal) throw new Interrupted(`pnpm install ended by ${install.signal}`);
  if (install.status !== 0) throw new Error(`pnpm install failed at ${commit.sha.slice(0, 10)}`);
}

function checkCommit(full) {
  return (checkout, commit) => {
    const plan = buildPrecommitPlan(commitEntries(commit.sha, checkout), { full });
    console.log(`plan (${plan.mode}): ${plan.steps.map(({ label }) => label).join(", ")}`);
    // Heavy steps write to the verification target: check the space where it lives.
    const env = prepareChecks(plan, { root: checkout, diskPath: repoRoot });
    return runPlan(plan, { env, cwd: checkout });
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const commits = listCommits(options.range);
  if (commits.length === 0) {
    console.log(`verify-commits: no commits in ${options.range}`);
    return 0;
  }
  if (options.dryRun) {
    for (const commit of commits) {
      const plan = buildPrecommitPlan(commitEntries(commit.sha), { full: options.full });
      console.log(
        `${commit.sha.slice(0, 10)} ${commit.subject}\n  ${plan.mode}: ${plan.steps.map(({ label }) => label).join(", ")}`,
      );
    }
    return 0;
  }
  const path = worktreePathFor(repoRoot);
  requireDiskSpace("verify-commits");
  // The checkout and its node_modules land here: a RAM-backed /tmp counts too.
  mkdirSync(dirname(path), { recursive: true });
  requireDiskSpace(`verify-commits (worktree under ${basename(dirname(path))})`, {
    path: dirname(path),
  });
  console.log(`verify-commits: ${commits.length} commit(s) of ${options.range} in ${path}`);
  const outcome = verifyCommits({
    root: repoRoot,
    commits,
    path,
    keepGoing: options.keepGoing,
    prepare: installDependencies,
    check: checkCommit(options.full),
  });
  console.log(formatSummary(commits, outcome));
  const failed = outcome.results.some(({ status }) => status !== 0);
  return failed || outcome.interrupted || outcome.results.length < commits.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-commits: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
