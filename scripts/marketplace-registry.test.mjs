import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

function runNestedTests(cwd, tests, inheritedEnv = process.env) {
  const env = { ...inheritedEnv };
  // A nested runner otherwise silently skips its suites under the root runner.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("registry tooling stays covered by the root test suite", () => {
  const cwd = fileURLToPath(new URL("../tooling/marketplace-registry/", import.meta.url));
  const result = spawnSync(process.execPath, ["tests/run.mjs"], {
    cwd,
    env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
    encoding: "utf8",
    timeout: 780_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("nested registry test launcher executes suites and propagates failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "registry-nested-tests-"));
  try {
    for (const fails of [false, true]) {
      const name = fails ? "intentional failure" : "executed success";
      writeFileSync(
        join(directory, "probe.test.mjs"),
        `import { test } from "node:test";
test(${JSON.stringify(name)}, () => { ${fails ? 'throw new Error("failure propagated");' : ""} });
`,
      );
      const result = runNestedTests(directory, ["probe.test.mjs"], {
        ...process.env,
        NODE_TEST_CONTEXT: "child-v8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert.match(result.stdout, /TAP version 13/);
      assert.ok(result.stdout.includes(`${fails ? "not ok" : "ok"} 1 - ${name}`), result.stdout);
      assert.match(result.stdout, /# tests 1\b/);
    }
  } finally {
    unlinkSync(join(directory, "probe.test.mjs"));
    rmdirSync(directory);
  }
});

test("portable registry fixtures stay byte-identical to the service contract", () => {
  for (const name of ["valid.json", "valid.signing.json"]) {
    const service = new URL(
      `../packages/service/tests/fixtures/managed_provider_index/v1/${name}`,
      import.meta.url,
    );
    const portable = new URL(
      `../tooling/marketplace-registry/tests/fixtures/${name}.fixture`,
      import.meta.url,
    );
    assert.deepEqual(readFileSync(portable), readFileSync(service));
  }
});
