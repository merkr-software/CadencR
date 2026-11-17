import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CARGO_LAST_USED_FILE,
  createCargoEnv,
  defaultRustTestThreads,
  markCargoUse,
  rustTestThreads,
  usesSccache,
} from "./cargo-env.mjs";

test("isolates Cargo artifacts and disables inherited incremental compilation", () => {
  const env = createCargoEnv(
    { CARGO_TARGET_DIR: "/repo/.shared-cargo-target/wt/old", CARGO_INCREMENTAL: "1" },
    { repoRoot: "/worktrees/feature" },
  );

  assert.equal(env.CARGO_TARGET_DIR, "/worktrees/feature/target");
  assert.equal(env.CARGO_INCREMENTAL, "0");
});

test("removes inherited sccache configuration and keeps incremental compilation disabled", () => {
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
  assert.equal(env.CARGO_INCREMENTAL, "0");
  assert.equal(env.SCCACHE_CACHE_SIZE, undefined);
});

test("preserves other rustc wrappers with incremental compilation disabled", () => {
  const env = createCargoEnv(
    {
      RUSTC_WRAPPER: "/usr/local/bin/custom-wrapper",
      RUSTC_WORKSPACE_WRAPPER: "/usr/local/bin/custom-workspace-wrapper",
    },
    { repoRoot: "/repo" },
  );

  assert.equal(env.RUSTC_WRAPPER, "/usr/local/bin/custom-wrapper");
  assert.equal(env.RUSTC_WORKSPACE_WRAPPER, "/usr/local/bin/custom-workspace-wrapper");
  assert.equal(env.CARGO_INCREMENTAL, "0");
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

test("the Rust test thread default keeps every CPU while idle, half of them under load", () => {
  const threads = (cpus, load) => defaultRustTestThreads({ cpus, load });
  assert.equal(threads(14, 0.5), 13, "an idle 14-core Mac");
  assert.equal(threads(14, 4), 10, "only the idle CPUs");
  assert.equal(threads(14, 40), 7, "a loaded machine keeps half");
  assert.equal(threads(4, 3.5), 4, "a 4-CPU CI runner keeps libtest's default");
  assert.equal(threads(6, 6), 4, "at least four");
  assert.equal(threads(2, 1), 2, "never more than the CPUs");
});

test("RUST_TEST_THREADS from the user wins over the machine default", () => {
  const machine = { cpus: 14, load: 40 };
  assert.equal(createCargoEnv({}, { repoRoot: "/r", machine }).RUST_TEST_THREADS, "7");
  assert.equal(
    createCargoEnv({ RUST_TEST_THREADS: "12" }, { repoRoot: "/r", machine }).RUST_TEST_THREADS,
    "12",
  );
});

test("rustTestThreads says where the value comes from", () => {
  assert.deepEqual(rustTestThreads({ RUST_TEST_THREADS: "3" }), {
    value: "3",
    source: "RUST_TEST_THREADS",
  });
  assert.deepEqual(rustTestThreads({}, { cpus: 4, load: 0 }), {
    value: "4",
    source: "machine default",
  });
});
