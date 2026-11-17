import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  formatSummary,
  listCommits,
  parseArgs,
  verifyCommits,
  worktreePathFor,
} from "./verify-commits.mjs";

test("arguments: one optional range and three flags", () => {
  assert.deepEqual(parseArgs([]), {
    range: "main..HEAD",
    full: false,
    keepGoing: false,
    dryRun: false,
  });
  assert.deepEqual(parseArgs(["HEAD~2..HEAD", "--full", "--keep-going"]), {
    range: "HEAD~2..HEAD",
    full: true,
    keepGoing: true,
    dryRun: false,
  });
  assert.equal(parseArgs(["--", "a..b"]).range, "a..b", "pnpm passes `--` through");
  assert.throws(() => parseArgs(["--no-verify"]), /unknown option --no-verify/);
  assert.throws(() => parseArgs(["a..b", "c..d"]), /expected one range/);
});

test("the worktree path is stable per checkout and distinct between checkouts", () => {
  assert.equal(worktreePathFor("/w/a", "/tmp"), worktreePathFor("/w/a", "/tmp"));
  assert.notEqual(worktreePathFor("/w/a", "/tmp"), worktreePathFor("/w/b", "/tmp"));
  assert.match(worktreePathFor("/w/a", "/tmp"), /^\/tmp\/cadencr-verify-[0-9a-f]{10}$/);
});

test("the summary marks failures and the commits never reached", () => {
  const commits = [
    { sha: "a".repeat(40), subject: "feat: one" },
    { sha: "b".repeat(40), subject: "fix: two" },
    { sha: "c".repeat(40), subject: "test: three" },
  ];
  const text = formatSummary(commits, {
    results: [
      { ...commits[0], status: 0, seconds: 12 },
      { ...commits[1], status: 2, seconds: 30 },
    ],
    interrupted: false,
  });
  assert.match(text, /ok +aaaaaaaaaa 12s +feat: one/);
  assert.match(text, /FAILED \(exit 2\) +bbbbbbbbbb 30s +fix: two/);
  assert.match(text, /skipped +cccccccccc +test: three/);
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A scratch repository whose commits write `state` = ok | broken. */
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "cadencr-verify-test-"));
  const repo = join(root, "repo");
  spawnSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "state"), "ok\n");
  git(repo, "add", "state");
  git(repo, "commit", "--quiet", "--no-verify", "-m", "chore: base");
  git(repo, "checkout", "--quiet", "-b", "feature");
  for (const [state, subject] of [
    ["ok", "feat: first"],
    ["broken", "feat: second"],
    ["ok", "fix: third"],
  ]) {
    writeFileSync(join(repo, "state"), `${state}\n${subject}\n`);
    git(repo, "commit", "--quiet", "--no-verify", "-am", subject);
  }
  writeFileSync(join(repo, "state"), "uncommitted edit\n");
  return { root, repo };
}

const checkState = (checkout) =>
  readFileSync(join(checkout, "state"), "utf8").startsWith("ok") ? 0 : 1;

test("every commit is checked in a detached worktree that is removed afterwards", () => {
  const { root, repo } = scratchRepo();
  try {
    const commits = listCommits("main..feature", repo);
    assert.deepEqual(
      commits.map(({ subject }) => subject),
      ["feat: first", "feat: second", "fix: third"],
    );
    const path = join(root, "verify");
    const seen = [];
    const outcome = verifyCommits({
      root: repo,
      commits,
      path,
      keepGoing: true,
      prepare: (checkout, commit, previous) => seen.push([commit.subject, previous?.subject]),
      check: (checkout) => {
        assert.equal(git(checkout, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
        return checkState(checkout);
      },
      log: () => {},
    });
    assert.deepEqual(
      outcome.results.map(({ subject, status }) => [subject, status]),
      [
        ["feat: first", 0],
        ["feat: second", 1],
        ["fix: third", 0],
      ],
    );
    assert.deepEqual(seen[1], ["feat: second", "feat: first"]);
    assert.equal(existsSync(path), false, "the temporary worktree is gone");
    assert.doesNotMatch(git(repo, "worktree", "list"), /verify\/checkout/);
    // The user's checkout is untouched: same branch, uncommitted edit kept.
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
    assert.equal(readFileSync(join(repo, "state"), "utf8"), "uncommitted edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without --keep-going the series stops at the first failure, and cleanup still runs", () => {
  const { root, repo } = scratchRepo();
  try {
    const path = join(root, "verify");
    const outcome = verifyCommits({
      root: repo,
      commits: listCommits("main..feature", repo),
      path,
      keepGoing: false,
      prepare: () => {},
      check: checkState,
      log: () => {},
    });
    assert.deepEqual(
      outcome.results.map(({ status }) => status),
      [0, 1],
    );
    assert.equal(existsSync(path), false);

    assert.throws(
      () =>
        verifyCommits({
          root: repo,
          commits: listCommits("main..feature", repo),
          path,
          keepGoing: false,
          prepare: () => {
            throw new Error("install failed");
          },
          check: checkState,
          log: () => {},
        }),
      /install failed/,
    );
    assert.equal(existsSync(path), false, "removed even when preparing throws");
    assert.doesNotMatch(git(repo, "worktree", "list"), /verify\/checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a leftover worktree from a crashed run is replaced, a live one is refused", () => {
  const { root, repo } = scratchRepo();
  try {
    const path = join(root, "verify");
    const commits = listCommits("main..feature", repo).slice(0, 1);
    const run = () =>
      verifyCommits({
        root: repo,
        commits,
        path,
        keepGoing: false,
        prepare: () => {},
        check: () => 0,
        log: () => {},
      });
    // Crashed run: worktree registered, pid of a process that is gone.
    git(repo, "worktree", "add", "--detach", "--quiet", join(path, "checkout"), commits[0].sha);
    writeFileSync(join(path, "pid"), "999999");
    assert.equal(run().results[0].status, 0);
    assert.equal(existsSync(path), false);

    git(repo, "worktree", "add", "--detach", "--quiet", join(path, "checkout"), commits[0].sha);
    writeFileSync(join(path, "pid"), String(process.pid));
    assert.throws(run, /another verification/);
    assert.ok(existsSync(join(path, "checkout")), "a live run's worktree is left alone");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", join(root, "verify", "checkout")], {
      cwd: repo,
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree whose directory vanished is forgotten, and only that one", () => {
  const { root, repo } = scratchRepo();
  try {
    const path = join(root, "verify");
    const commits = listCommits("main..feature", repo).slice(0, 1);
    // The user's own worktree on a volume that is not mounted right now.
    const elsewhere = join(root, "unmounted");
    git(repo, "worktree", "add", "--detach", "--quiet", elsewhere, commits[0].sha);
    rmSync(elsewhere, { recursive: true, force: true });
    // A crashed run whose checkout directory is gone but still registered.
    git(repo, "worktree", "add", "--detach", "--quiet", join(path, "checkout"), commits[0].sha);
    rmSync(join(path, "checkout"), { recursive: true, force: true });

    const outcome = verifyCommits({
      root: repo,
      commits,
      path,
      keepGoing: false,
      prepare: () => {},
      check: () => 0,
      log: () => {},
    });
    assert.equal(outcome.results[0].status, 0);
    const list = git(repo, "worktree", "list");
    assert.doesNotMatch(list, /verify\/checkout/);
    assert.match(list, /unmounted/, "another missing worktree is not pruned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ctrl-C during a step stops the series and still removes the worktree", () => {
  const { root, repo } = scratchRepo();
  try {
    const path = join(root, "verify");
    const runner = join(root, "runner.mjs");
    const module = (name) => JSON.stringify(pathToFileURL(join(import.meta.dirname, name)).href);
    // The step dies of SIGINT like a Ctrl-C'd command, and the runner gets
    // one too. The step resets SIGINT first: shells started in the background
    // (CI, agents) begin with it ignored, and children inherit that.
    const interruptedStep = [
      "-I",
      "-c",
      "import os, signal; signal.signal(signal.SIGINT, signal.SIG_DFL); " +
        "os.kill(os.getppid(), signal.SIGINT); os.kill(os.getpid(), signal.SIGINT)",
    ];
    writeFileSync(
      runner,
      `import { spawnSync } from "node:child_process";
import { exitStatus } from ${module("pre-commit.mjs")};
import { listCommits, verifyCommits } from ${module("verify-commits.mjs")};
const outcome = verifyCommits({
  root: ${JSON.stringify(repo)},
  commits: listCommits("main..feature", ${JSON.stringify(repo)}),
  path: ${JSON.stringify(path)},
  keepGoing: true,
  prepare: () => {},
  check: () => exitStatus(spawnSync("python3", ${JSON.stringify(interruptedStep)})),
  log: () => {},
});
console.log(JSON.stringify(outcome));
`,
    );
    const run = spawnSync(process.execPath, [runner], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const outcome = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(outcome.interrupted, true);
    assert.equal(outcome.results.length, 1, "--keep-going does not run the next commit");
    assert.equal(outcome.results[0].status, 130);
    assert.equal(existsSync(path), false, "the worktree is removed");
    assert.doesNotMatch(git(repo, "worktree", "list"), /verify\/checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
