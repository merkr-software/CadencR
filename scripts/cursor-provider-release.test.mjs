import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const { parse } = createRequire(import.meta.url)("yaml");
const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

test("compiled Cursor publication binds native payloads and build provenance", () => {
  const result = spawnSync("python3", ["test_cursor_release.py"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("native release jobs have four native targets and no publication credential", () => {
  const build = workflow("cursor-provider-build.yml");
  assert.deepEqual(build.permissions, { contents: "read" });
  assert.deepEqual(build.jobs.native.strategy.matrix.include.map((row) => row.target).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
  ]);
  assert.ok(build.jobs.native.steps.some((step) => step.run?.includes("scripts/qualify.py")));
  assert.ok(build.jobs.native.steps.every((step) => !/cache/.test(step.uses ?? "")));
  assert.equal(JSON.stringify(build).includes("secrets."), false);
  assert.equal(build.jobs.native.environment, undefined);
  assert.equal(build.jobs.prepare.environment, undefined);
  assert.equal(build.jobs.prepare.needs, "native");
});

test("compiled author publication preserves exact confirmation and credential isolation", () => {
  const author = workflow("cursor-provider-author.yml");
  assert.deepEqual(author.permissions, { contents: "read", actions: "read" });
  assert.match(author.jobs.inspect.if, /refs\/heads\/main/);
  assert.equal(author.jobs.publish.environment, "official-plugin-publication");
  assert.equal(author.jobs.publish.if, "needs.inspect.outputs.confirmed == 'true'");
  for (const job of Object.values(author.jobs)) {
    assert.ok(job.steps.some((step) => step.run?.includes("scripts/cursor-release-stage.py")));
    assert.ok(job.steps.every((step) => !step.run?.includes("${{ inputs.")));
    const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with.ref, "${{ github.sha }}");
    assert.equal(checkouts[0].with["fetch-depth"], 0);
  }
  const credentials = author.jobs.publish.steps.filter((step) =>
    JSON.stringify(step).includes("secrets.CADENCR_AUTHOR_GITHUB_TOKEN"),
  );
  assert.equal(credentials.length, 1);
  assert.match(credentials[0].run, /plugin publish-release/);
  assert.equal(JSON.stringify(author.jobs.inspect).includes("secrets."), false);
});
