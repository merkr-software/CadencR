import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../scripts/lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("copied registry runs standalone and emits exact signing bytes without a newline", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cadencr-registry-template-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const copy = path.join(temporary, "registry");
  await cp(root, copy, { recursive: true });
  await copyFile(
    path.join(copy, "tests/fixtures/example-provider.json.fixture"),
    path.join(copy, "packages/example-provider-0.1.0.json"),
  );
  const run = (args) => {
    const result = spawnSync(process.execPath, args, {
      cwd: copy,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  run(["--test", "tests/registry.test.mjs"]);
  run(["scripts/validate.mjs"]);
  const output = path.join(temporary, "payload.json");
  run([
    "scripts/build-index.mjs",
    "--generated-at",
    new Date().toISOString(),
    "--expires-at",
    new Date(Date.now() + 86400000).toISOString(),
    "--output",
    output,
  ]);
  const payload = await readFile(output, "utf8");
  assert.equal(payload, canonicalJson(JSON.parse(payload)));
});

test("copied registry tests and validation support an empty bootstrap catalog", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cadencr-empty-registry-template-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const copy = path.join(temporary, "registry");
  await cp(root, copy, { recursive: true });
  const packages = path.join(copy, "packages");
  await rm(packages, { recursive: true });
  await mkdir(packages);
  await writeFile(path.join(packages, ".gitkeep"), "");

  const run = (args) => {
    const result = spawnSync(process.execPath, args, {
      cwd: copy,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };

  // Do not recursively launch the complete suite from within its own CLI test.
  run([
    "--test",
    "tests/registry.test.mjs",
    "tests/submission-cli.test.mjs",
    "tests/contribution-workflow.test.mjs",
  ]);
  run(["scripts/validate.mjs"]);
});
