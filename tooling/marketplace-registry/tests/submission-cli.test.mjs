import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../scripts/validate-submission.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("submission CLI validates provenance without fetching or changing files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-submission-cli-"));
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/example/example-provider";
  pkg.agent.distribution.binary["darwin-aarch64"].archive =
    `${pkg.agent.repository}/releases/download/v0.1.0/provider.tar.gz`;
  const text = JSON.stringify({
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "Initial version",
  });
  const file = path.join(directory, "submission.json");
  await writeFile(file, text);
  const result = run(file);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid submission:/);
  assert.equal(await readFile(file, "utf8"), text);
});

test("submission CLI reports usage, unreadable, malformed and oversized input", async () => {
  assert.equal(run().status, 1);
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-submission-cli-"));
  assert.equal(run(path.join(directory, "missing.json")).status, 1);
  assert.equal(run(directory).status, 1);
  const file = path.join(directory, "invalid.json");
  await writeFile(file, "{");
  assert.equal(run(file).status, 1);
  await writeFile(file, " ".repeat(1024 * 1024 + 1));
  const result = run(file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 MiB/);
});
