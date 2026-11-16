import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { parse } = require("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/dependency-audit.yml", import.meta.url), "utf8"),
);

test("dependency audits cover pull requests, releases and newly disclosed advisories", () => {
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.push.branches, ["main", "v*"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.ok(workflow.on.schedule.some(({ cron }) => typeof cron === "string" && cron.length > 0));
  assert.deepEqual(workflow.permissions, { contents: "read" });
});

test("pull requests are audited whenever a dependency input or the audit itself changes", () => {
  const paths = workflow.on.pull_request?.paths ?? [];
  for (const input of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "**/package.json",
    "patches/**",
    ".github/workflows/dependency-audit.yml",
  ]) {
    assert.ok(paths.includes(input), `pull_request.paths must include ${input}`);
  }
  // Pushes, tags and the schedule must keep auditing every revision.
  assert.equal(workflow.on.push.paths, undefined);
  assert.equal(workflow.on.push["paths-ignore"], undefined);
});

test("the audit includes development dependencies and fails closed at every severity", () => {
  const job = workflow.jobs["pnpm-audit"];
  const audit = job.steps.find(({ run }) => run?.startsWith("pnpm audit"));
  assert.equal(audit?.run, "pnpm audit --audit-level=low");
  assert.equal(job["continue-on-error"] ?? false, false);
  assert.equal(audit["continue-on-error"] ?? false, false);
  assert.equal(audit.if, undefined);
  assert.ok(job["timeout-minutes"] > 0);
});
