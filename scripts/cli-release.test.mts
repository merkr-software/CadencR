import { test } from "node:test";
import assert from "node:assert/strict";
import { stableVersion, workflow } from "./cli-release.mts";

const manifest = (version: string) => `[package]\nname = "cadencr-cli"\nversion = "${version}"\n`;
const pkg = (version: unknown) => JSON.stringify({ name: "@cadencr/cli", version });

test("stable release version comes unchanged from agreeing CLI manifests", () => {
  assert.equal(stableVersion(manifest("0.14.0"), pkg("0.14.0")), "0.14.0");
  assert.equal(stableVersion(manifest("1.20.3"), pkg("1.20.3")), "1.20.3");
  assert.equal(workflow, ".github/workflows/cli-release.yml");
});

test("prereleases, malformed versions and disagreeing manifests are refused", () => {
  for (const version of ["0.14.0-dev.1.1", "0.14.0-rc.1", "01.2.3", "1.2", "v1.2.3", "1.2.3\n"])
    assert.throws(() => stableVersion(manifest(version), pkg(version)), version);
  assert.throws(() => stableVersion(manifest("0.14.0"), pkg("0.14.1")));
  assert.throws(() => stableVersion(manifest("0.14.0"), pkg(undefined)));
  assert.throws(() => stableVersion('[package]\nname = "cadencr-cli"\n', pkg("0.14.0")));
});
