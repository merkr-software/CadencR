import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARGO_LAST_USED_FILE, createCargoEnv, markCargoUse, usesSccache } from "./cargo-env.mjs";

test("forces Cargo artifacts into the current worktree target", () => {
  const env = createCargoEnv(
    { CARGO_TARGET_DIR: "/repo/.shared-cargo-target/wt/old" },
    { repoRoot: "/worktrees/feature" },
  );

  assert.equal(env.CARGO_TARGET_DIR, "/worktrees/feature/target");
});

test("removes inherited sccache configuration and restores Cargo defaults", () => {
  const env = createCargoEnv(
    {
      RUSTC_WRAPPER: "sccache",
      RUSTC_WORKSPACE_WRAPPER: "/opt/homebrew/bin/sccache",
      CARGO_INCREMENTAL: "1",
      SCCACHE_CACHE_SIZE: "4G",
    },
    { repoRoot: "/repo" },
  );

  assert.equal(env.RUSTC_WRAPPER, undefined);
  assert.equal(env.RUSTC_WORKSPACE_WRAPPER, undefined);
  assert.equal(env.CARGO_INCREMENTAL, undefined);
  assert.equal(env.SCCACHE_CACHE_SIZE, undefined);
});

test("does not alter incremental settings for another rustc wrapper", () => {
  const env = createCargoEnv(
    {
      RUSTC_WRAPPER: "/usr/local/bin/custom-wrapper",
      RUSTC_WORKSPACE_WRAPPER: "/usr/local/bin/custom-workspace-wrapper",
    },
    { repoRoot: "/repo" },
  );

  assert.equal(env.RUSTC_WRAPPER, "/usr/local/bin/custom-wrapper");
  assert.equal(env.RUSTC_WORKSPACE_WRAPPER, "/usr/local/bin/custom-workspace-wrapper");
});

test("recognizes sccache by executable basename", () => {
  assert.equal(usesSccache("/opt/homebrew/bin/sccache"), true);
  assert.equal(usesSccache("sccache"), true);
  assert.equal(usesSccache("sccache.exe"), true);
  assert.equal(usesSccache("/tmp/not-sccache-wrapper"), false);
});

test("marks the target when the Cargo wrapper is used", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-cargo-env-"));
  const target = join(root, "target");

  try {
    markCargoUse(target);
    assert.equal(readFileSync(join(target, CARGO_LAST_USED_FILE), "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
