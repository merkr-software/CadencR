import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "registry-launcher-")));
  t.after(() => rm(root, { recursive: true }));
  const directory = path.join(root, "tooling/marketplace-registry");
  await mkdir(path.join(directory, "tests/helpers"), { recursive: true });
  for (const name of ["run.mjs", "helpers/native-cli.mjs"]) {
    await copyFile(new URL(name, import.meta.url), path.join(directory, "tests", name));
  }
  const binary = path.join(root, "target/debug/cadencr");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 99\n"); // Never executed: plumbing-only binary sentinel.
  await chmod(binary, 0o700);
  for (const index of [1, 2, 3]) {
    await writeFile(
      path.join(directory, `tests/probe-${index}.test.mjs`),
      `
import assert from "node:assert/strict";
import { test } from "node:test";
test("worker ${index} executes", () => {
  assert.equal(process.env.CADENCR_REGISTRY_TEST_CLI, ${JSON.stringify(binary)});
  if (process.env.PROBE_FAIL === "1" && ${index} === 2) throw new Error("propagated failure");
});
`,
    );
  }
  return { root, directory, binary };
}

function run(directory, env) {
  const result = spawnSync(process.execPath, ["tests/run.mjs"], {
    cwd: directory,
    env: { ...process.env, NODE_TEST_CONTEXT: "child-v8", ...env },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

test("portable launcher resolves source CLI exactly once for independent Node workers", async (t) => {
  const { root, directory, binary } = await fixture(t);
  await mkdir(path.join(root, "packages/cli"), { recursive: true });
  await writeFile(path.join(root, "packages/cli/Cargo.toml"), "# inert source marker\n");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const log = path.join(root, "build-calls.jsonl");
  const pnpm = path.join(bin, "pnpm");
  await writeFile(
    pnpm,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(Number(process.env.BUILD_STATUS ?? 0));
`,
  );
  await chmod(pnpm, 0o700);
  const result = run(directory, {
    CADENCR_REGISTRY_TEST_CLI: "",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# tests 3\b/);
  assert.equal(
    await readFile(log, "utf8"),
    `${JSON.stringify(["rust", "--", "build", "-p", "cadencr-cli"])}\n`,
  );
  assert.equal((await readFile(binary, "utf8")).includes("exit 99"), true);
  const failedBuild = run(directory, {
    CADENCR_REGISTRY_TEST_CLI: "",
    BUILD_STATUS: "17",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.notEqual(failedBuild.status, 0);
  assert.doesNotMatch(failedBuild.stdout, /worker [123] executes/);
  assert.match(failedBuild.stderr, /17 !== 0/);
});

test("portable launcher honors explicit CLI, executes nested suites and propagates failures", async (t) => {
  const { directory, binary } = await fixture(t);
  for (const fails of [false, true]) {
    const result = run(directory, {
      CADENCR_REGISTRY_TEST_CLI: binary,
      PROBE_FAIL: fails ? "1" : "0",
    });
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 3\b/);
    assert.match(result.stdout, fails ? /not ok .*worker 2 executes/ : /ok .*worker 2 executes/);
  }
  const missing = run(directory, { CADENCR_REGISTRY_TEST_CLI: `${binary}-missing` });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
});
