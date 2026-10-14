import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./qualify-released-cli-github.sh", import.meta.url).pathname;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("GitHub contract preflight rejects authority, targets and unverified inputs without execution", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-github-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "executed");
  const cli = path.join(root, "cadencr");
  writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const key = path.join(root, "private.pem");
  writeFileSync(key, "inert key data, never parsed", { mode: 0o600 });
  const submission = path.join(root, "submission.json");
  writeFileSync(
    submission,
    JSON.stringify({ source: { repository: "https://github.com/example/qa-source" } }),
  );
  const request = path.join(root, "request.json");
  const value = {
    schema_version: 2,
    repository: "example/qa-registry",
    previous_index: "bootstrap",
    publications: [{ submission: "submission.json" }],
  };
  const raw = JSON.stringify(value);
  writeFileSync(request, raw);
  const env = {
    PATH: process.env.PATH,
    CLI: cli,
    QA_REPOSITORY: value.repository,
    QA_SOURCE_REPOSITORY: "example/qa-source",
    QA_CONFIRM_TARGETS: "example/qa-registry\nexample/qa-source",
    QA_REGISTRY_COMMIT: "a".repeat(40),
    QA_REQUEST_SHA256: digest(raw),
    QA_REQUEST: request,
    QA_PRIVATE_KEY: key,
  };
  const run = (extra = {}, phase = "preflight") =>
    spawnSync("sh", [script, phase], { encoding: "utf8", env: { ...env, ...extra } });
  const reject = (extra, message, phase) => {
    const result = run(extra, phase);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(marker), false);
  };
  for (const phase of ["publication", "resume", "replay", "renewal"])
    reject({}, /only preflight is implemented/, phase);
  for (const name of ["CADENCR_REGISTRY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"])
    reject({ [name]: "not-a-real-token" }, /credentials forbidden/);
  for (const name of [
    "QA_REPOSITORY",
    "QA_SOURCE_REPOSITORY",
    "QA_CONFIRM_TARGETS",
    "QA_REGISTRY_COMMIT",
    "QA_REQUEST_SHA256",
    "QA_REQUEST",
    "QA_PRIVATE_KEY",
    "CLI",
  ])
    reject({ [name]: "" }, new RegExp(`${name} is required`));
  reject({ QA_REPOSITORY: "merkr-software/cadencr-registry" }, /production repository forbidden/);
  reject({ QA_SOURCE_REPOSITORY: "MERKR-SOFTWARE/CADENCR" }, /production repository forbidden/);
  reject({ QA_SOURCE_REPOSITORY: value.repository }, /must be distinct/);
  reject({ QA_CONFIRM_TARGETS: "example/not-reviewed" }, /confirmation mismatch/);
  reject({ QA_REGISTRY_COMMIT: "main" }, /exact lowercase/);
  reject({ QA_REQUEST_SHA256: "b".repeat(64) }, /reviewed request digest mismatch/);
  reject({}, /CLI digest mismatch/);
  const link = path.join(root, "key-link");
  symlinkSync(key, link);
  reject({ QA_PRIVATE_KEY: link }, /non-symlink/);
  const alter = (next, message) => {
    const bytes = typeof next === "string" ? next : JSON.stringify(next);
    writeFileSync(request, bytes);
    reject({ QA_REQUEST_SHA256: digest(bytes) }, message);
  };
  alter({ ...value, repository: "example/other" }, /reviewed scratch repository/);
  alter({ ...value, previous_index: "prior.json" }, /only bootstrap/);
  alter({ ...value, publications: [] }, /renewal is not implemented/);
  alter({ ...value, publications: [{ submission: "../outside.json" }] }, /inside reviewed/);
  alter('{"schema_version":2,"schema_version":2}', /duplicate request field/);
  alter('{"invalid":NaN}', /nonfinite request value/);
  alter('{"invalid":1e999}', /nonfinite request or submission value/);
  writeFileSync(request, raw);
  writeFileSync(submission, '{"value":1e999}');
  reject({}, /nonfinite request or submission value/);
  writeFileSync(
    submission,
    JSON.stringify({ source: { repository: "https://github.com/example/not-reviewed" } }),
  );
  reject({}, /reviewed scratch source repository/);
});

test("contract-only driver does not claim remote qualification or invoke publication commands", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /fetch-released-cli\.sh/);
  assert.match(source, /'lifecycle_qualified': False/);
  assert.match(source, /'semantic_preflight': 'pending'/);
  assert.match(source, /'remote_verification': 'pending'/);
  assert.match(source, /raise SystemExit\(3\)/);
  assert.doesNotMatch(
    source,
    /registry (publish-registry|mirror-publication|promote-publication|advance-catalog)/,
  );
  assert.doesNotMatch(source, /curl|git push|chmod|private\.read|private\.open/);
});
