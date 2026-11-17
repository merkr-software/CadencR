import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEFAULT_MIN_FREE_GIB, diskSpaceProblem, freeBytesAt, minFreeGib } from "./disk-space.mjs";

const GIB = 1024 ** 3;

test("the threshold defaults, can be overridden and refuses nonsense", () => {
  assert.equal(minFreeGib({}), DEFAULT_MIN_FREE_GIB);
  assert.equal(minFreeGib({ CADENCR_MIN_FREE_DISK_GIB: "25" }), 25);
  assert.equal(minFreeGib({ CADENCR_MIN_FREE_DISK_GIB: "0" }), 0);
  assert.throws(() => minFreeGib({ CADENCR_MIN_FREE_DISK_GIB: "lots" }), /number of GiB/);
  assert.throws(() => minFreeGib({ CADENCR_MIN_FREE_DISK_GIB: "-1" }), /number of GiB/);
});

test("below the threshold the message names the operation, the space and the fixes", () => {
  const problem = diskSpaceProblem({
    operation: "pnpm dev:precompile",
    path: "/repo",
    freeBytes: 3.25 * GIB,
    minGib: 10,
  });
  assert.match(problem, /^pnpm dev:precompile: only 3\.3 GiB free on the volume holding \/repo/);
  assert.match(problem, /at least 10 GiB/);
  assert.match(problem, /pnpm rust:storage/);
  assert.match(problem, /CADENCR_MIN_FREE_DISK_GIB/);
});

test("enough space, or a disabled check, passes", () => {
  const at = (freeBytes, minGib) =>
    diskSpaceProblem({ operation: "x", path: "/", freeBytes, minGib });
  assert.equal(at(10 * GIB, 10), null);
  assert.equal(at(1, 0), null);
});

test("freeBytesAt reads the real volume", () => {
  assert.ok(freeBytesAt(".") > 0);
});

test("the CLI exits 1 with the message when the threshold is unreachable", () => {
  const result = spawnSync(process.execPath, ["scripts/disk-space.mjs", "test build"], {
    encoding: "utf8",
    env: { ...process.env, CADENCR_MIN_FREE_DISK_GIB: String(1024 ** 3) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^test build: only .* GiB free/);
  const passing = spawnSync(process.execPath, ["scripts/disk-space.mjs", "x"], {
    env: { ...process.env, CADENCR_MIN_FREE_DISK_GIB: "0" },
  });
  assert.equal(passing.status, 0);
});
