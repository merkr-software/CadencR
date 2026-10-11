import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the shared application release keeps CLI manifests and lockfile versions aligned", () => {
  const desktop = JSON.parse(read("packages/desktop/package.json"));
  const cli = JSON.parse(read("packages/cli/package.json"));
  const manifest = read("packages/cli/Cargo.toml")
    .split(/^\[package\]\s*$/m)[1]
    ?.split(/^\[/m)[0];
  const locked = read("Cargo.lock")
    .split(/^\[\[package\]\]\s*$/m)
    .find((entry) => /^name\s*=\s*"cadencr-cli"\s*$/m.test(entry));
  const version = (section) => section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

  assert.equal(typeof desktop.version, "string", "desktop must declare the release version");
  assert.equal(cli.version, desktop.version, "CLI package.json must match the app release");
  assert.equal(version(manifest), desktop.version, "CLI Cargo.toml must match the app release");
  assert.equal(version(locked), desktop.version, "locked CLI must match the app release");
});
