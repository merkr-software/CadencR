import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/validate-provider-metadata.yml", import.meta.url);

const readWorkflow = () => readFile(workflowUrl, "utf8");

const jobSections = (workflow) => {
  const toolingStart = workflow.indexOf("  contributor-tooling:");
  assert.notEqual(toolingStart, -1, "contributor-tooling job must exist");
  return {
    inert: workflow.slice(0, toolingStart),
    tooling: workflow.slice(toolingStart),
  };
};

test("PR validation runs trusted base tooling against separately checked-out candidate metadata", async () => {
  const workflow = await readWorkflow();
  const { inert } = jobSections(workflow);

  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.base\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /path: trusted-registry/);
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /path: candidate-registry/);
  assert.match(
    workflow,
    /node trusted-registry\/scripts\/validate-contribution\.mjs\s+--base trusted-registry\s+--candidate candidate-registry/,
  );
  assert.doesNotMatch(inert, /candidate-registry\/scripts\/|npm (?:test|run)/);
});

test("PR validation stays read-only and does not acquire credentials or privileged triggers", async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /^permissions:\s*\n\s+contents: read\s*$/m);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run|workflow_dispatch/);
  assert.doesNotMatch(workflow, /secrets\.|contents:\s*write|id-token:\s*write/);
  assert.doesNotMatch(workflow, /download-artifact|curl|wget|npm\s+(?:ci|install)|pnpm|yarn/);
});

test("candidate tooling checks remain isolated from the trusted metadata gate", async () => {
  const workflow = await readWorkflow();
  const { tooling } = jobSections(workflow);

  assert.match(
    tooling,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  );
  assert.match(tooling, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(tooling, /working-directory: candidate-registry\s+run: npm test/);
  assert.match(tooling, /working-directory: candidate-registry\s+run: npm run validate/);
  assert.match(tooling, /npm run build:index/);
  assert.match(tooling, /set -- packages\/\*\.json\s+if \[ -e "\$1" \]; then/);
  assert.match(tooling, /No publishable package JSON; skipping index assembly\./);
  assert.doesNotMatch(
    tooling,
    /trusted-registry|needs:|environment:|secrets\.|cache:|upload-artifact/,
  );
});

test("all registry contribution and CI changes trigger validation", async () => {
  const workflow = await readWorkflow();

  // An unfiltered pull_request trigger covers packages/, submissions/, workflow,
  // validator, package manifest, and test changes without a drifting path list.
  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
});

test("candidate index assembly explicitly skips an empty bootstrap catalog", async () => {
  const workflow = await readWorkflow();
  const { tooling } = jobSections(workflow);
  const block = tooling.match(
    /- name: Build a throwaway candidate index\n\s+working-directory: candidate-registry\n\s+run: \|\n((?: {10}.*\n?)+)/,
  );
  assert.ok(block, "index assembly shell block must exist");
  const script = block[1].replace(/^ {10}/gm, "");
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-empty-workflow-"));
  await mkdir(path.join(directory, "packages"));
  await writeFile(path.join(directory, "packages/.gitkeep"), "");

  const result = spawnSync("/bin/sh", ["-c", script], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: directory },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No publishable package JSON; skipping index assembly\./);
});
