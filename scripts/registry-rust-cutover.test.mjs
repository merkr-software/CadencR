import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const template = new URL("../tooling/marketplace-registry/", import.meta.url);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? files(url) : [url];
  });
}

test("registry template contains only thin CI adapters, not a second business runtime", () => {
  const scripts = new URL("scripts/", template);
  assert.deepEqual(
    files(scripts)
      .map((file) => file.href.slice(scripts.href.length))
      .sort(),
    [
      "ci/confirm-provider-handoffs.cjs",
      "ci/fetch-released-cli.sh",
      "ci/registry-feeds.sh",
      "ci/select-publisher-runtime.sh",
      "ci/validate-provider-contribution.sh",
    ],
  );
  const manifest = JSON.parse(readFileSync(new URL("package.json", template), "utf8"));
  assert.deepEqual(manifest.scripts, { test: "node tests/run.mjs" });
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
});

test("portable tests do not import or execute removed business scripts", () => {
  for (const file of files(new URL("tests/", template)).filter((url) =>
    url.pathname.endsWith(".mjs"),
  )) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\.\.\/scripts\/(?!ci\/)[\w/-]+\.mjs/);
  }
});

test("current registry instructions use Rust commands instead of removed npm business aliases", () => {
  for (const name of [
    "README.md",
    "AUTHORING.md",
    "CONTRIBUTING.md",
    "OPERATIONS.md",
    "SECURITY.md",
  ]) {
    assert.doesNotMatch(
      readFileSync(new URL(name, template), "utf8"),
      /npm run (?:validate|build:index|assemble:index|sign:|pack:|plan:|stage:|mirror:|promote:|publish:|advance:)|node scripts\/[\w-]+\.mjs/,
      name,
    );
  }
});
