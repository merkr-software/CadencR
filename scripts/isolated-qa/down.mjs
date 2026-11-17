// `pnpm qa:down <run>`: stop exactly the processes one run started (identity
// re-checked by PID + start time) and remove exactly the files it owns.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitCommonDir } from "../git-worktrees.mts";
import {
  ancestorPids,
  isSameProcess,
  listenerPids,
  readProcessTable,
  stopRunProcesses,
} from "./processes.mjs";
import {
  DISPOSABLE_KEYS,
  qaRoot,
  readState,
  resolveRunDir,
  runLayout,
  writeState,
} from "./run.mjs";

/** Worktrees the app created under the run's data root (`<data>/worktrees/<project>/<name>`). */
export function runWorktrees(layout) {
  const root = join(layout.data, "worktrees");
  if (!existsSync(root)) return [];
  const worktrees = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const entry of readdirSync(join(root, project.name), { withFileTypes: true })) {
      const dir = join(root, project.name, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, ".git"))) worktrees.push(dir);
    }
  }
  return worktrees;
}

/** Where a linked worktree's `.git` file points (its admin dir in the owning repository). */
function gitAdminDir(worktree) {
  const match = readFileSync(join(worktree, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m);
  return match ? resolve(worktree, match[1].trim()) : join(worktree, ".git");
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * A run worktree registered in a repository outside the run (a QA that added a
 * real project) is unregistered from it with `git worktree remove` — only that
 * worktree, nothing else of the repository. Its branch is left for the user.
 * Returns the problems met; the scratch project's worktrees need nothing.
 */
export function detachExternalWorktrees(layout) {
  const problems = [];
  for (const worktree of runWorktrees(layout)) {
    // A worktree whose repository is gone has nothing left to unregister.
    if (!existsSync(gitAdminDir(worktree))) continue;
    try {
      const commonDir = gitCommonDir(worktree);
      if (commonDir.startsWith(`${layout.runDir}/`)) continue;
      const branch = git(["-C", worktree, "rev-parse", "--abbrev-ref", "HEAD"]);
      git(["--git-dir", commonDir, "worktree", "remove", "--force", worktree]);
      console.log(`  removed worktree ${worktree} from ${commonDir} (branch ${branch} kept)`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : error;
      problems.push(
        `${worktree}: ${reason}\n  fix by hand: git -C <its repository> worktree remove --force ${worktree}`,
      );
    }
  }
  return problems;
}

function report(result) {
  for (const row of result.stopped) {
    const how = result.killed.includes(row) ? "SIGKILL" : "SIGTERM";
    console.log(`  stopped pid ${row.pid} (${how}): ${row.command.slice(0, 100)}`);
  }
  for (const record of result.skipped) {
    console.log(
      `  not running: ${record.role} pid ${record.pid} (exited, or PID reused: not touched)`,
    );
  }
}

/** Whatever still mentions the run after shutdown (excluding this command and its parents). */
export function leftovers(state) {
  const table = readProcessTable();
  const self = ancestorPids(table);
  const processes = table.filter((row) => !self.has(row.pid) && row.command.includes(state.runDir));
  const ports = Object.entries(state.ports).filter(([, port]) => listenerPids(port).length > 0);
  return { processes, ports };
}

function printLeftovers(state) {
  try {
    const rest = leftovers(state);
    for (const row of rest.processes) {
      console.log(`  still mentions the run: pid ${row.pid} ${row.command.slice(0, 100)}`);
    }
    for (const [name, port] of rest.ports) {
      console.log(`  port ${port} (${name}) is listening again, not by this run`);
    }
  } catch (error) {
    console.error(
      `  could not check for leftovers: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}

/**
 * A `qa:up` still starting this run (or cleaning up its failed start) would
 * recreate or rewrite what `down` removes.
 */
function refuseWhileStarting(state) {
  if (["ready", "down"].includes(state.status) || !state.starter) return;
  if (!isSameProcess(state.starter, readProcessTable())) return;
  throw new Error(
    `qa:up (pid ${state.starter.pid}) is still starting this run; stop it first or wait for it`,
  );
}

export async function down({ target, purge }) {
  const runDir = resolveRunDir(target, qaRoot());
  const state = readState(runDir);
  const layout = runLayout(runDir);
  refuseWhileStarting(state);
  console.log(`Stopping QA run ${state.runId}`);
  const result = await stopRunProcesses(state.processes, layout);
  report(result);
  if (result.remaining.length > 0) {
    const pids = result.remaining.map((row) => row.pid).join(", ");
    throw new Error(`processes ${pids} survived SIGKILL; nothing was removed`);
  }
  const problems = detachExternalWorktrees(layout);
  if (problems.length > 0) {
    throw new Error(`could not detach run worktrees; run files were kept:\n${problems.join("\n")}`);
  }
  for (const key of DISPOSABLE_KEYS) rmSync(layout[key], { recursive: true, force: true });
  if (purge) {
    rmSync(runDir, { recursive: true, force: true });
    console.log(`Removed ${runDir}`);
  } else {
    state.status = "down";
    state.stoppedAt = new Date().toISOString();
    state.processes = [];
    writeState(layout, state);
    console.log(`Kept for the report: ${layout.evidence}, ${layout.screenshots}/, ${layout.logs}/`);
    console.log(`Remove them with: pnpm qa:down ${runDir} --purge`);
  }
  printLeftovers(state);
}
