import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parse } from "yaml";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "author-qa-guard-"));
  mkdirSync(join(root, "scripts/author-cli-qa"), { recursive: true });
  cpSync(resolve("scripts/qualify-author-cli.py"), join(root, "scripts/qualify-author-cli.py"));
  cpSync(resolve("scripts/author-cli-qa"), join(root, "scripts/author-cli-qa"), {
    recursive: true,
  });
  const candidate = {
    kind: "theme",
    cli_version: "0.13.1-dev.123.1",
    cli_sha256: "a".repeat(64),
    repository: "merkr-software/cadencr-registry-qa",
    repository_id: 1420296872,
    public: true,
    expected_account: "qa-user",
    tag: "qa-author-cli/guard-test",
    source_commit: "b".repeat(40),
  };
  const data = JSON.stringify(candidate) + "\n";
  writeFileSync(join(root, "author-cli-candidate.json"), data);
  const pin = `CADENCR_RELEASE_VERSION=${candidate.cli_version}\nCADENCR_RELEASE_TAG=cli/v${candidate.cli_version}\nCADENCR_RELEASE_SHA256=${candidate.cli_sha256}\n`;
  writeFileSync(join(root, "author-cli-pin.env"), pin);
  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: candidate.repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "c".repeat(40),
    REVIEWED_COMMIT: "c".repeat(40),
    CANDIDATE_SHA256: sha256(data),
    GITHUB_WORKFLOW_REF: `${candidate.repository}/.github/workflows/author.yml@refs/heads/main`,
  };
  const run = () =>
    spawnSync("python3", ["-B", join(root, "scripts/author-cli-qa/guard.py")], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
  return { root, candidate, env, pin, run };
}

test("author QA guard binds reviewed context and exact candidate/binary pin", () => {
  for (const optimized of [false, true]) {
    const f = fixture();
    if (optimized) f.env.PYTHONOPTIMIZE = "2";
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("author QA guard rejects other contexts and changed pins before execution", () => {
  const changes = [
    (f) => (f.env.GITHUB_REPOSITORY = "merkr-software/CadencR"),
    (f) => (f.env.GITHUB_EVENT_NAME = "push"),
    (f) => (f.env.GITHUB_REF = "refs/heads/other"),
    (f) => (f.env.REVIEWED_COMMIT = "d".repeat(40)),
    (f) => (f.env.GITHUB_WORKFLOW_REF = "unreviewed"),
    (f) => (f.env.CANDIDATE_SHA256 = "e".repeat(64)),
    (f) => writeFileSync(join(f.root, "author-cli-pin.env"), "PENDING\n"),
    (f) =>
      writeFileSync(join(f.root, "author-cli-pin.env"), f.pin + "CADENCR_RELEASE_VERSION=evil\n"),
    (f) => {
      f.candidate.repository_id = 1;
      const data = JSON.stringify(f.candidate);
      writeFileSync(join(f.root, "author-cli-candidate.json"), data);
      f.env.CANDIDATE_SHA256 = sha256(data);
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "AUTHOR_QA_CONTEXT_OR_PIN_REJECTED\n");
  }
});

test("author QA workflow isolates the ELF and limits the user secret to online QA", () => {
  const source = readFileSync("scripts/author-cli-qa/workflow.yml", "utf8");
  const workflow = parse(source);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(workflow.jobs.offline["runs-on"], "ubuntu-24.04");
  assert.match(workflow.jobs.offline.if, /merkr-software\/cadencr-registry-qa/);
  assert.match(workflow.jobs.offline.if, /refs\/heads\/main/);
  assert.equal(workflow.jobs.author.needs, "offline");
  assert.equal(workflow.jobs.author.if, "inputs.publish == true");
  assert.equal(source.match(/secrets\.QA_AUTHOR_GITHUB_TOKEN/g)?.length, 1);
  assert.doesNotMatch(source, /contents: write|download-artifact|pull_request|environment:/);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.match(upload.with.path, /^\$\{\{ runner.temp \}\}\/author-[a-z-]+-proof\.json$/);
  }
  const offline = workflow.jobs.offline.steps.find((step) => step.run?.includes("unshare"));
  assert.match(offline.run, /unshare --net/);
  assert.match(offline.run, /env -i PATH=\/usr\/bin:\/bin/);
});
