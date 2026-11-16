import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const version = (section) => section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

// The CLI has its own semver (released by .github/workflows/cli-release.yml),
// independent of the app version, but its three version records must agree.
test("the CLI's package.json, Cargo.toml and locked version are equal", () => {
  const cli = JSON.parse(read("packages/cli/package.json"));
  const manifest = read("packages/cli/Cargo.toml")
    .split(/^\[package\]\s*$/m)[1]
    ?.split(/^\[/m)[0];
  const locked = read("Cargo.lock")
    .split(/^\[\[package\]\]\s*$/m)
    .find((entry) => /^name\s*=\s*"cadencr-cli"\s*$/m.test(entry));

  assert.match(cli.version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "stable semver");
  assert.equal(version(manifest), cli.version, "CLI Cargo.toml must match its package.json");
  assert.equal(version(locked), cli.version, "locked CLI must match its package.json");
});

test("the app release preflight no longer requires the CLI to carry the app version", () => {
  const files = read("scripts/release.sh").split(/^FILES$/m)[0];
  assert.doesNotMatch(files, /^packages\/cli\//m);
});
