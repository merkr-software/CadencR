import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devVersion,
  repository,
  validateContext,
  validateCi,
  ciPredicate,
} from "./cli-dev-release.mts";
const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  SOURCE_COMMIT: sha,
  GITHUB_SHA: sha,
};
test("canonical reviewed main tip only", () => {
  validateContext(env, sha);
  for (const patch of [
    { GITHUB_REPOSITORY: "fork/repo" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/other" },
    { SOURCE_COMMIT: "main" },
    { GITHUB_SHA: "b".repeat(40) },
  ])
    assert.throws(() => validateContext({ ...env, ...patch }, sha));
  assert.throws(() => validateContext(env, "b".repeat(40)));
});
test("immutable canonical dev versions", () => {
  assert.equal(devVersion("0.13.1", "123", "2"), "0.13.1-dev.123.2");
  for (const args of [
    ["01.2.3", "1", "1"],
    ["1.2.3-dev.1", "1", "1"],
    ["1.2.3", "01", "1"],
    ["1.2.3", "1", "0"],
    ["1.2.3", "1", "1\n"],
  ])
    assert.throws(() => devVersion(...(args as [string, string, string])));
});
test("CI requires success, never pending failure or absent", () => {
  const run = {
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
  };
  validateCi("true\n");
  for (const output of ["true", "false\n", "true\nnoise", " true\n", "TRUE\n", "", "null\n"]) {
    assert.throws(() => validateCi(output));
  }
  const evaluate = (runs: unknown[], totalCount = runs.length) =>
    execFileSync("jq", ["-r", ciPredicate(sha)], {
      input: JSON.stringify({ total_count: totalCount, workflow_runs: runs }),
      encoding: "utf8",
    });
  assert.equal(evaluate([run]), "true\n");
  for (const runs of [
    [],
    [{ ...run, status: "in_progress" }],
    [{ ...run, conclusion: "failure" }],
    [{ ...run, event: "pull_request" }],
    [{ ...run, head_branch: "feature/not-main" }],
    [{ ...run, repository: { full_name: "fork/CadencR" } }],
    [{ ...run, head_sha: "b".repeat(40) }],
    [run, { ...run, status: "queued" }],
  ])
    assert.throws(() => validateCi(evaluate(runs)));
  assert.throws(() => validateCi(evaluate([run], 2)), "incomplete CI pages must fail closed");
});
