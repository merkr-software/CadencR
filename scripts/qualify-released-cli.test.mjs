import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./qualify-released-cli.sh", import.meta.url).pathname;
const pins = new URL("./cli-qualification.env", import.meta.url);
const workflow = new URL("../.github/workflows/cli-qualification.yml", import.meta.url);

test("offline qualification rejects unverified executables before execution or workspace creation", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-qualification-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "executed");
  const binary = path.join(root, "cadencr");
  writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  const work = path.join(root, "work");
  const run = (cli, extra = {}) =>
    spawnSync("sh", [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CLI: cli, CLI_WORK_ROOT: work, ...extra },
    });
  assert.match(run(binary).stderr, /digest mismatch/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(work), false);
  const link = path.join(root, "link");
  symlinkSync(binary, link);
  assert.match(run(link).stderr, /non-symlink/);
  assert.match(
    run(binary, { CADENCR_REGISTRY_GITHUB_TOKEN: "not-a-real-token" }).stderr,
    /token forbidden/,
  );
  assert.match(run(binary, { GITHUB_TOKEN: "not-a-real-token" }).stderr, /token forbidden/);
  assert.equal(existsSync(work), false);
});

test("qualification pins and upload boundary do not activate production or leak generated keys", () => {
  assert.equal(
    readFileSync(pins, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .join("\n"),
    "CADENCR_RELEASE_VERSION=0.13.0\nCADENCR_RELEASE_SHA256=d3223e3b3ff74543595fd3354c3249f50fa01def65f376a624eb1fbc8072df2a",
  );
  const production = readFileSync(
    new URL("../tooling/marketplace-registry/ci/released-cli.env", import.meta.url),
    "utf8",
  );
  assert.match(production, /CADENCR_RELEASE_VERSION=PENDING/);
  assert.match(production, /CADENCR_RELEASE_SHA256=PENDING/);
  const yaml = readFileSync(workflow, "utf8");
  assert.match(yaml, /runs-on: ubuntu-24\.04/);
  assert.match(yaml, /contents: read/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /sudo unshare --net -- setpriv/);
  assert.match(yaml, /--bounding-set=-all --no-new-privs/);
  assert.match(readFileSync(script, "utf8"), /value.get\('code'\)!=sys.argv\[2\]/);
  assert.match(
    yaml,
    /path: \$\{\{ runner.temp \}\}\/cli-offline-qualification\/evidence\/evidence.json/,
  );
  assert.doesNotMatch(yaml, /secrets\.|cargo|pull_request|schedule:|contents: write/);
  const shell = readFileSync(script, "utf8");
  assert.match(shell, /env -i PATH=/);
  assert.match(shell, /lifecycle_qualified':False/);
  assert.match(shell, /interruption_resume':'pending'/);
  assert.match(shell, /renewal':'pending'/);
  assert.doesNotMatch(
    shell,
    /registry (publish-registry|mirror-publication|promote-publication|advance-catalog)/,
  );
  assert.match(shell, /timeout --kill-after=2s 30s/);
  assert.match(shell, /ulimit -f 128/);
});
