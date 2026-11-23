import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fixture } from "./official-plugin-fixtures.mjs";

test("preparation cleans child scratch on success and failure and preserves outputs", (t) => {
  const f = fixture(t);
  const tmp = join(f.root, "tmp");
  mkdirSync(join(tmp, "official-plugin-unrelated"), { recursive: true });
  const success = f.run(undefined, { TMPDIR: tmp });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, "");
  assert.deepEqual(readdirSync(tmp), ["official-plugin-unrelated"]);

  writeFileSync(join(f.root, "bad-cli"), "yes");
  const result = f.run(undefined, { TMPDIR: tmp });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin validate failed \(INERT_FIXTURE_FAILURE\)/);
  assert.equal(result.stderr.includes("sensitive-marker"), false);
  assert.equal(result.stderr.includes("PRIVATE_DIAG_MARKER"), false);
  assert.deepEqual(readdirSync(tmp), ["official-plugin-unrelated"]);
  const logPath = /Private CLI diagnostics: (.+)/.exec(result.stderr)?.[1];
  assert.ok(logPath);
  assert.equal(dirname(logPath), dirname(result.output));
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  const log = readFileSync(logPath);
  assert.ok(log.length <= 65536);
  assert.ok(log.includes(Buffer.from("PRIVATE_DIAG_MARKER")));
  assert.equal(existsSync(result.output), false);
  const release = JSON.parse(readFileSync(join(success.output, "release.json")));
  assert.deepEqual(
    readdirSync(success.output).sort(),
    [
      ...release.archives.map(({ name }) => name),
      "SHA256SUMS",
      "package.json",
      "release.json",
      "submission.json",
    ].sort(),
  );
});
