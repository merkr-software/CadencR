import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARGO_LAST_USED_FILE } from "./cargo-env.mjs";
import {
  collectDirectoryStats,
  parseAge,
  parseCleanArgs,
  parsePruneArgs,
  parseWorktreeList,
  selectPruneCandidates,
} from "./rust-storage.mjs";

test("parses NUL-delimited worktree records without losing spaces", () => {
  const output = [
    "worktree /repo/main\0HEAD abc\0branch refs/heads/main",
    "worktree /repo/worktrees/feature with spaces\0HEAD def\0detached",
    "",
  ].join("\0\0");

  assert.deepEqual(parseWorktreeList(output), [
    "/repo/main",
    "/repo/worktrees/feature with spaces",
  ]);
});

test("parses day and hour retention values", () => {
  assert.equal(parseAge("14d"), 14 * 24 * 60 * 60 * 1000);
  assert.equal(parseAge("24h"), 24 * 60 * 60 * 1000);
  assert.throws(() => parseAge("two-weeks"), /Invalid age/);
});

test("rejects missing option values", () => {
  assert.throws(() => parseCleanArgs(["--profile", "--apply"]), /Missing value for --profile/);
  assert.throws(
    () => parsePruneArgs(["--older-than", "--apply"]),
    /Missing value for --older-than/,
  );
});

test("uses the Cargo wrapper marker as the last-used time", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-rust-storage-"));
  const target = join(root, "target");
  const marker = join(target, CARGO_LAST_USED_FILE);
  mkdirSync(target);
  writeFileSync(join(target, "artifact"), "artifact");
  writeFileSync(marker, "");
  utimesSync(join(target, "artifact"), 1, 1);
  utimesSync(marker, 2, 2);

  try {
    assert.equal(collectDirectoryStats(target).lastUsedMs, 2_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune candidates exclude current, main, recent, missing, and symlink targets", () => {
  const old = 100;
  const recent = 1_000;
  const entries = [
    { worktree: "/repo/main", exists: true, isSymlink: false, lastUsedMs: old },
    { worktree: "/repo/current", exists: true, isSymlink: false, lastUsedMs: old },
    { worktree: "/repo/old", exists: true, isSymlink: false, lastUsedMs: old },
    { worktree: "/repo/recent", exists: true, isSymlink: false, lastUsedMs: recent },
    { worktree: "/repo/missing", exists: false, isSymlink: false, lastUsedMs: old },
    { worktree: "/repo/link", exists: true, isSymlink: true, lastUsedMs: old },
  ];

  assert.deepEqual(selectPruneCandidates(entries, "/repo/current", "/repo/main", 500), [
    entries[2],
  ]);
});
