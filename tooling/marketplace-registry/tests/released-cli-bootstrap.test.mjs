import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/ci/fetch-released-cli.sh", import.meta.url).pathname;

test("trusted bootstrap parses inert pins and bounds verified official downloads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "released-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools");
  await mkdir(tools);
  // CI uses coreutils timeout; this inert local shim exercises process-group
  // cancellation quickly on macOS, which does not ship that utility.
  await writeFile(
    path.join(tools, "timeout"),
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.shift() !== "--kill-after=2s" || args.shift() !== "30s") process.exit(99);
const child = spawn(args.shift(), args, { stdio: "inherit", detached: true });
const timer = setTimeout(() => { process.kill(-child.pid, "SIGKILL"); }, 500);
child.on("exit", (code) => { clearTimeout(timer); process.exit(code ?? 124); });
`,
    { mode: 0o700 },
  );
  const marker = path.join(root, "executed");
  const bytes = Buffer.from(
    `#!/bin/sh\necho version >> '${marker}'\necho "cadencr \${FAKE_VERSION:-1.2.3}"\n`,
  );
  const fixture = path.join(root, "fixture");
  await writeFile(fixture, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const requests = path.join(root, "requests");
  await writeFile(
    path.join(tools, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${requests}'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    --dump-header) headers=$2; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "\${FAKE_REDIRECT:-}" ]; then
  printf 'Location: %s\\r\\n' "$FAKE_REDIRECT" > "$headers"
  printf 302
else
  cp '${fixture}' "$out"
  printf 200
fi
exit "\${FAKE_CURL_EXIT:-0}"
`,
    { mode: 0o700 },
  );
  await writeFile(path.join(tools, "sha256sum"), '#!/bin/sh\nshasum -a 256 "$1"\n', {
    mode: 0o700,
  });
  let counter = 0;
  const run = async (pin, environment = {}, output) => {
    const pinPath = path.join(root, `pin-${counter++}`);
    await writeFile(pinPath, pin);
    const target = output ?? path.join(root, `output-${counter}`);
    const result = spawnSync("/bin/sh", [script, pinPath, target], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, ...environment },
    });
    return { ...result, target };
  };
  const validPin = `CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=${digest}\n`;
  for (const pin of [
    "CADENCR_RELEASE_VERSION=PENDING\nCADENCR_RELEASE_SHA256=PENDING\n",
    `CADENCR_RELEASE_VERSION=PENDING\nCADENCR_RELEASE_SHA256=${digest}\n`,
    "CADENCR_RELEASE_VERSION=1.2.3\nCADENCR_RELEASE_SHA256=PENDING\n",
    validPin + "CADENCR_RELEASE_VERSION=1.2.3\n",
    validPin + `EVIL=$(touch ${marker})\n`,
    "CADENCR_RELEASE_VERSION=1.2.3\n",
    validPin.replace("1.2.3", "$(touch nope)"),
  ]) {
    const result = await run(pin);
    assert.equal(
      result.status,
      pin.includes("VERSION=PENDING\nCADENCR_RELEASE_SHA256=PENDING") ? 3 : 2,
      result.stderr,
    );
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(result.target), /ENOENT/);
    await assert.rejects(readFile(requests), /ENOENT/);
    await assert.rejects(readFile(marker), /ENOENT/);
  }
  const collision = await run(validPin, { FAKE_CURL_EXIT: "3" });
  assert.equal(collision.status, 1, collision.stderr);
  await assert.rejects(readFile(marker), /ENOENT/);
  const originalBytes = bytes;
  for (const body of ["exec sleep 60", "while :; do printf 'noisy-output'; done", "exit 3"]) {
    const replacement = Buffer.from(`#!/bin/sh\n${body}\n`);
    await writeFile(fixture, replacement);
    const replacementDigest = createHash("sha256").update(replacement).digest("hex");
    const result = await run(validPin.replace(digest, replacementDigest));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /version (?:check|output)/);
  }
  await writeFile(fixture, originalBytes);
  const badDigest = await run(validPin.replace(digest, "0".repeat(64)));
  assert.notEqual(badDigest.status, 0);
  assert.match(badDigest.stderr, /SHA-256 mismatch/);
  await assert.rejects(readFile(marker), /ENOENT/);
  const wrongVersion = await run(validPin, { FAKE_VERSION: "9.9.9" });
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr, /version mismatch/);
  await rm(marker);
  for (const redirect of [
    "http://github.com/nope",
    "https://github.com.evil.invalid/a",
    "https://github.com@evil.invalid/a",
    "https://release-assets.githubusercontent.com/a",
  ]) {
    const result = await run(validPin, { FAKE_REDIRECT: redirect });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      redirect.endsWith(".com/a") ? /redirect limit/ : /untrusted redirect/,
    );
    assert.equal(result.stdout, "");
    await assert.rejects(readFile(marker), /ENOENT/);
  }
  const existing = path.join(root, "existing");
  await writeFile(existing, "preserved");
  const linked = path.join(root, "linked");
  await symlink(existing, linked);
  for (const target of [existing, linked, tools]) {
    const result = await run(validPin, {}, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  }
  assert.equal(await readFile(existing, "utf8"), "preserved");
  const success = await run(validPin);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `${await realpath(success.target)}/cadencr\n`);
  assert.equal(await readFile(marker, "utf8"), "version\n");
  const args = await readFile(requests, "utf8");
  assert.match(args, /--proto =https --max-redirs 0/);
  assert.match(args, /--connect-timeout 15 --max-time 120 --max-filesize 134217728/);
  assert.match(
    args,
    /https:\/\/github.com\/merkr-software\/CadencR\/releases\/download\/v1.2.3\/cadencr-v1.2.3-x86_64-unknown-linux-gnu/,
  );
});
