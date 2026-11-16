import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { parse } = require("yaml");
const semver = require("semver");
const lock = parse(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
const desktop = JSON.parse(
  readFileSync(new URL("../packages/desktop/package.json", import.meta.url), "utf8"),
);

// Extensions exchange class instances, facets, NodeProps and highlight Tags.
// Multiple package instances can crash the editor or silently remove syntax colors.
const sharedPackages = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
  "@lezer/common",
  "@lezer/highlight",
];

function assertSharedVersion(graph, name, declaredRange) {
  for (const section of ["packages", "snapshots"]) {
    const versions = new Set(
      Object.keys(graph[section])
        .filter((key) => key.startsWith(`${name}@`))
        .map((key) => key.slice(name.length + 1).split("(")[0]),
    );
    assert.equal(versions.size, 1, `${name} must have one shared version in ${section}`);
    if (declaredRange) {
      const [version] = versions;
      assert.ok(
        semver.satisfies(version, declaredRange),
        `${name}@${version} does not satisfy ${declaredRange}; update its override too`,
      );
    }
  }
}

test("CodeMirror and Lezer share compatible identities across the dependency graph", () => {
  for (const name of sharedPackages) {
    assertSharedVersion(lock, name, desktop.devDependencies[name]);
  }
});

test("a nested old copy cannot hide behind the upgraded direct dependency", () => {
  const entries = { "@codemirror/state@6.7.6": {}, "@codemirror/state@6.7.0": {} };
  assert.throws(
    () => assertSharedVersion({ packages: entries, snapshots: entries }, "@codemirror/state"),
    /one shared version/,
  );
});

test("an old override cannot silently suppress a requested upgrade", () => {
  const entries = { "@codemirror/state@6.7.0": {} };
  assert.throws(
    () =>
      assertSharedVersion({ packages: entries, snapshots: entries }, "@codemirror/state", "^6.7.6"),
    /does not satisfy/,
  );
});
