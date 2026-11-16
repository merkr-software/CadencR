import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const text = readFileSync(new URL("./cli-qualification/workflow.yml", import.meta.url), "utf8");
const workflow = parse(text);
const steps = workflow.jobs.offline.steps;
const guard = steps.find((step) => step.name?.startsWith("Verify reviewed")).run;

test("three-kind hosted offline guard binds repository, workflow, reviewed commit and exact pins", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "three-kind-qa-workflow-")));
  const pins =
    "CADENCR_RELEASE_VERSION=0.13.1-dev.39108033875.1\nCADENCR_RELEASE_SHA256=" +
    "a".repeat(64) +
    "\n";
  writeFileSync(join(root, "offline-cli-pin.env"), pins);
  writeFileSync(
    join(root, "offline-fetch-pin.env"),
    pins + "CADENCR_RELEASE_TAG=cli/v0.13.1-dev.39108033875.1\n",
  );
  const env = {
    PATH: process.env.PATH,
    GITHUB_REPOSITORY: "merkr-software/cadencr-registry-qa",
    GITHUB_REPOSITORY_ID: "1420296872",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF:
      "merkr-software/cadencr-registry-qa/.github/workflows/offline.yml@refs/heads/main",
    REVIEWED_COMMIT: "b".repeat(40),
    GITHUB_SHA: "b".repeat(40),
    PINS_SHA256: createHash("sha256").update(pins).digest("hex"),
  };
  const run = (extra = {}) =>
    spawnSync("sh", ["-c", guard], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run().status, 0);
  for (const extra of [
    { GITHUB_REPOSITORY: "merkr-software/cadencr-registry" },
    { GITHUB_REPOSITORY_ID: "1" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_SHA: "c".repeat(40) },
    { PINS_SHA256: "d".repeat(64) },
    {
      GITHUB_WORKFLOW_REF:
        "merkr-software/cadencr-registry-qa/.github/workflows/other.yml@refs/heads/main",
    },
  ])
    assert.notEqual(run(extra).status, 0);
  writeFileSync(
    join(root, "offline-fetch-pin.env"),
    pins + "CADENCR_RELEASE_TAG=cli/v0.13.1-dev.1.1\n",
  );
  assert.notEqual(run().status, 0);
  // A stable cli-release.yml pin is accepted under the same cli/v binding.
  for (const [version, valid] of [
    ["0.14.0", true],
    ["0.14.0-rc.1", false],
  ]) {
    const stable = `CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_SHA256=${"a".repeat(64)}\n`;
    writeFileSync(join(root, "offline-cli-pin.env"), stable);
    writeFileSync(
      join(root, "offline-fetch-pin.env"),
      stable + `CADENCR_RELEASE_TAG=cli/v${version}\n`,
    );
    const pinned = { PINS_SHA256: createHash("sha256").update(stable).digest("hex") };
    assert.equal(run(pinned).status === 0, valid, version);
  }
});

test("three-kind offline job has no write authority and exports evidence only", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.offline["runs-on"], "ubuntu-24.04");
  assert.equal(steps[0].with["persist-credentials"], false);
  assert.equal(steps[0].with.ref, "${{ github.sha }}");
  assert.doesNotMatch(text, /secrets\.|contents: write|cargo|pull_request|schedule:/);
  const execution = steps.find((step) => step.name?.startsWith("Exercise all")).run;
  assert.match(execution, /sudo unshare --net -- setpriv/);
  assert.match(execution, /--bounding-set=-all --no-new-privs/);
  assert.match(execution, /env -i PATH=\/usr\/bin:\/bin/);
  assert.match(execution, /CLI_QUALIFICATION_PINS=/);
  const upload = steps.at(-1);
  assert.equal(upload.with.path, "${{ runner.temp }}/three-kind-offline/evidence/evidence.json");
  assert.equal(upload.if, "${{ always() }}");
  for (const step of steps.filter((step) => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
});

test("reviewed CLI selection is atomic across repository consumers and bound by the author policy", () => {
  const selected = readFileSync(new URL("./cli-qualification.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  for (const file of [
    "../tooling/marketplace-registry/ci/released-cli.env",
    "./official-plugin-author-cli.env",
  ]) {
    assert.deepEqual(
      readFileSync(new URL(file, import.meta.url), "utf8")
        .split("\n")
        .filter((line) => line && !line.startsWith("#")),
      selected,
    );
  }
  const preflight = readFileSync(
    new URL("./qualify-released-cli-github.sh", import.meta.url),
    "utf8",
  );
  for (const pin of selected) assert.ok(preflight.includes(pin));
  const version = selected[0].split("=")[1];
  assert.ok(preflight.includes(`b'cadencr ${version}\\n\\nstatus:0\\n'`));
  const policy = JSON.parse(
    readFileSync(new URL("./official-plugin-author-policy.json", import.meta.url), "utf8"),
  );
  // Publication approval binds the exact selected author pin and its qualification.
  const sha256 = (path) =>
    createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex");
  assert.equal(policy.publication, "APPROVED");
  assert.equal(policy.author_cli_version, version);
  assert.equal(policy.author_cli_sha256, selected[1].split("=")[1]);
  assert.equal(policy.author_cli_pin_sha256, sha256("./official-plugin-author-cli.env"));
  assert.equal(
    policy.author_cli_qualification_sha256,
    sha256("./official-plugin-author-qualification.json"),
  );
});
