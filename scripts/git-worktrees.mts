import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function parseWorktreeList(output: string): string[] {
  const worktrees: string[] = [];
  for (const record of output.split("\0\0")) {
    const field = record.split("\0").find((value) => value.startsWith("worktree "));
    if (field) worktrees.push(field.slice("worktree ".length));
  }
  return worktrees;
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

export interface GitCheckout {
  gitDir: string;
  commonDir: string;
  /** A `git worktree add` checkout: its git dir lives under the common dir. */
  linkedWorktree: boolean;
}

/** Locate `cwd`'s git dirs with one `git rev-parse` call. */
export function gitCheckout(cwd: string): GitCheckout {
  const output = runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines.some((line) => !line)) {
    throw new Error(`unexpected git rev-parse output: ${output}`);
  }
  const [gitDir, commonDir] = lines.map((line) => resolve(line));
  return { gitDir, commonDir, linkedWorktree: gitDir !== commonDir };
}

export function gitCommonDir(cwd: string): string {
  return gitCheckout(cwd).commonDir;
}

export function listGitWorktrees(cwd: string): string[] {
  return parseWorktreeList(runGit(cwd, ["worktree", "list", "--porcelain", "-z"]));
}
