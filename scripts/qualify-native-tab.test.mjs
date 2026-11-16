import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./qualify-released-cli.sh", import.meta.url).pathname;

test("native qualification keeps all contributor bytes inert and delegates validation to the CLI", () => {
  const shell = readFileSync(new URL("./qualify-native-tab.sh", import.meta.url), "utf8");
  assert.match(readFileSync(script, "utf8"), /\. "\$SCRIPT_ROOT\/qualify-native-tab.sh"/);
  assert.match(shell, /plugin validate .* --kind tab --no-run/);
  assert.equal((shell.match(/plugin validate/g) ?? []).length, 1);
  assert.doesNotMatch(
    shell,
    /publish-release|stage-publication|curl|wget|cargo|subprocess|os\.system/,
  );
  for (const boundary of [
    "pack-tab-backend",
    "pack-tab",
    "validate-metadata",
    "validate-submission",
    "inspect-release",
  ])
    assert.ok(shell.includes(boundary), boundary);
  for (const probe of [
    "reject-native-archive-tampering",
    "reject-native-executable-tampering",
    "reject-native-embedded-binary",
    "reject-native-binding-",
    "reject-native-manifest-",
  ])
    assert.ok(shell.includes(probe), probe);
  assert.match(shell, /test "\$result" -eq 2/);
  assert.match(shell, /e\['code'\]=='CLI_USAGE_ERROR'/);
  assert.match(shell, /assert a\['executable_size'\]==b\['executable_size'\]/);
});

test("native fixture generator creates three non-runnable format headers and a separate web staging tree", (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cli-native-fixtures-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "qualification-tab"));
  writeFileSync(
    path.join(root, "qualification-tab/tab.json"),
    JSON.stringify({
      schema_version: 1,
      kind: "tab",
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      api_version: 1,
      entry: "dist/index.html",
    }),
  );
  const shell = readFileSync(new URL("./qualify-native-tab.sh", import.meta.url), "utf8");
  const body = shell.split("python3 - <<'PY'\n")[1].split("\nPY\n")[0];
  const result = spawnSync("python3", ["-c", body], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, CLI_WORK_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, "native-tab/tab.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.backend.binary), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
  ]);
  for (const [platform, relative] of Object.entries(manifest.backend.binary)) {
    const bytes = readFileSync(path.join(root, "native-tab", relative));
    assert.ok(bytes.length <= 72, platform);
    assert.equal(statSync(path.join(root, "native-tab", relative)).mode & 0o777, 0o755);
    assert.equal(existsSync(path.join(root, "native-web", relative)), false);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "native-web/tab.json"), "utf8")),
    manifest,
  );
  const invalid = JSON.parse(
    readFileSync(path.join(root, "native-invalid-protocol/tab.json"), "utf8"),
  );
  assert.equal(invalid.backend.protocol, 999);
});
