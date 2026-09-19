import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(
  new URL("../.github/workflows/publish-protected-catalog.yml", import.meta.url),
  "utf8",
);

const occurrences = (pattern) => [...source.matchAll(pattern)].length;

function inlineNodeScript(stepName) {
  const start = source.indexOf(`      - name: ${stepName}`);
  const end = source.indexOf("\n      - name:", start + 1);
  const step = source.slice(start, end < 0 ? undefined : end);
  const match = step.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(match, `missing inline Node script for ${stepName}`);
  return match[1].replace(/^ {10}/gm, "");
}

function runInline(stepName, env) {
  return spawnSync(process.execPath, ["-e", inlineNodeScript(stepName)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("publisher is a manually dispatched, default-branch-only protected workflow", () => {
  assert.match(source, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(source, /^  (pull_request|push|workflow_run):/m);
  assert.match(
    source,
    /confirm-request-sha256:\n        description:[^\n]+\n        required: true/,
  );
  assert.match(source, /^permissions:\n  contents: read$/m);
  assert.match(
    source,
    /^concurrency:\n  group: marketplace-publication\n  cancel-in-progress: false$/m,
  );
  assert.equal(
    occurrences(
      /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/g,
    ),
    2,
  );
  assert.match(source, /environment: protected-marketplace-publisher/);
  assert.match(source, /required\n    # external reviewers/);
});

test("both jobs checkout only the dispatched commit without credentials", () => {
  assert.equal(occurrences(/uses: actions\/checkout@v4/g), 2);
  assert.equal(occurrences(/ref: \$\{\{ github\.sha \}\}/g), 2);
  assert.equal(occurrences(/persist-credentials: false/g), 2);
  assert.doesNotMatch(source, /github\.event\.pull_request|head\.sha|checkout@(?:main|master)/);
});

test("digest preflight is bounded and precedes every privileged operation", () => {
  const preflight = source.indexOf("jobs:\n  preflight:");
  const protectedJob = source.indexOf("\n  publish:");
  const secret = source.indexOf("secrets.CADENCR_REGISTRY_PRIVATE_KEY_PEM");
  const token = source.indexOf("secrets.CADENCR_REGISTRY_GITHUB_TOKEN");
  assert.ok(preflight >= 0 && protectedJob > preflight);
  assert.ok(
    source.indexOf("reviewed publication request digest mismatch", preflight) < protectedJob,
  );
  assert.ok(source.indexOf("metadata.size > 1024 * 1024", preflight) < protectedJob);
  assert.ok(source.indexOf("metadata.isSymbolicLink()", preflight) < protectedJob);
  assert.ok(secret > protectedJob && token > secret);
  assert.equal(occurrences(/secrets\.CADENCR_REGISTRY_GITHUB_TOKEN/g), 1);
  assert.equal(occurrences(/secrets\.CADENCR_REGISTRY_PRIVATE_KEY_PEM/g), 1);
});

test("privileged command uses repository-bound environment values and reviewed config", () => {
  assert.match(
    source,
    /node scripts\/publish-registry\.mjs\n          --request publication-request\.json\n          --directory "\$RUNNER_TEMP\/marketplace-publication-state"\n          --repository "\$GITHUB_REPOSITORY"\n          --registry-commit "\$GITHUB_SHA"\n          --private-key "\$PRIVATE_KEY_FILE"\n          --confirm-request-sha256 "\$CONFIRM_REQUEST_SHA256"/,
  );
  assert.doesNotMatch(source, /--public-key|npm (?:install|ci|test)|pnpm|yarn/);
  assert.doesNotMatch(source, /\$\{\{ inputs\.confirm-request-sha256 \}\}[^\n]*--/);
});

test("private key stays outside recoverable state and is cleaned on every outcome", () => {
  assert.match(source, /writeFileSync\(file, key, \{ flag: "wx", mode: 0o600 \}\)/);
  assert.match(source, /Buffer\.byteLength\(key, "utf8"\) > 16 \* 1024/);
  assert.match(
    source,
    /appendFileSync\(process\.env\.GITHUB_OUTPUT, `private_key_file=\$\{file\}\\n`\)/,
  );
  assert.match(
    source,
    /name: Remove materialized signing key\n        if: \$\{\{ always\(\) && steps\.materialize_key\.outputs\.private_key_file != '' \}\}/,
  );
  assert.match(source, /unlinkSync\(file\)/);
  assert.doesNotMatch(source, /path:.*private\.pem/);
  assert.match(source, /path: \$\{\{ runner\.temp \}\}\/marketplace-publication-state\//);
});

test("materialization and cleanup scripts enforce owned private key lifecycle at runtime", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "publisher-workflow-test-"));
  const output = path.join(root, "github-output");
  writeFileSync(output, "");
  const created = runInline("Materialize protected signing key", {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "test-private-key",
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: output,
  });
  assert.equal(created.status, 0, created.stderr);
  const file = readFileSync(output, "utf8").trim().slice("private_key_file=".length);
  assert.equal(readFileSync(file, "utf8"), "test-private-key");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const cleaned = runInline("Remove materialized signing key", {
    PRIVATE_KEY_FILE: file,
    PRIVATE_KEY_ROOT: root,
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.throws(() => statSync(file), { code: "ENOENT" });

  const foreign = path.join(root, "private.pem");
  writeFileSync(foreign, "operator-owned");
  const refused = runInline("Remove materialized signing key", {
    PRIVATE_KEY_FILE: foreign,
    PRIVATE_KEY_ROOT: root,
  });
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(foreign, "utf8"), "operator-owned");

  const external = mkdtempSync(path.join(os.tmpdir(), "publisher-workflow-external-"));
  const externalKey = path.join(external, "private.pem");
  writeFileSync(externalKey, "foreign-through-parent");
  const linkedParent = path.join(root, "marketplace-publisher-secret-linked");
  symlinkSync(external, linkedParent, "dir");
  const refusedParent = runInline("Remove materialized signing key", {
    PRIVATE_KEY_FILE: path.join(linkedParent, "private.pem"),
    PRIVATE_KEY_ROOT: root,
  });
  assert.notEqual(refusedParent.status, 0);
  assert.equal(readFileSync(externalKey, "utf8"), "foreign-through-parent");

  const oversizedOutput = path.join(root, "oversized-output");
  writeFileSync(oversizedOutput, "");
  const oversized = runInline("Materialize protected signing key", {
    CADENCR_REGISTRY_PRIVATE_KEY_PEM: "x".repeat(16 * 1024 + 1),
    PRIVATE_KEY_ROOT: root,
    GITHUB_OUTPUT: oversizedOutput,
  });
  assert.notEqual(oversized.status, 0);
  assert.equal(readFileSync(oversizedOutput, "utf8"), "");
});

test("failure state is uniquely preserved without automatic artifact restore", () => {
  assert.match(
    source,
    /name: Preserve publication recovery state\n        if: \$\{\{ always\(\) \}\}/,
  );
  assert.match(
    source,
    /name: marketplace-publication-state-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(source, /timeout-minutes: 30/);
  assert.doesNotMatch(source, /actions\/download-artifact/);
  assert.match(source, /There is no automatic hosted resume/);
});
