import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve the existing build-tool dependencies from their workspace, rather
// than adding another YAML parser or semver implementation just for this gate.
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const { parse } = require("yaml");
const semver = require("semver");
const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const lock = parse(read("pnpm-lock.yaml"));
const workspace = parse(read("pnpm-workspace.yaml"));

// Security floors, not exact pins: later compatible patches may be installed
// without rewriting this test. Keep separate major lines for CJS/ESM consumers.
// These also cover the newer maintainer fast-uri port-injection advisory and
// registry js-yaml empty-merge, baseline mapping and smol-toml DoS advisories.
const safeVersions = {
  "@vitest/mocker": ">=4.1.11",
  "@xmldom/xmldom": ">=0.8.15",
  astro: ">=7.2.8",
  axios: ">=1.20.0",
  "baseline-browser-mapping": ">=2.11.0",
  "brace-expansion": "^1.1.21 || ^2.1.7 || >=5.0.12",
  browserslist: ">=4.28.7",
  dompurify: ">=3.4.16",
  electron: "^42.10.0 || ^43.5.0 || >=44.0.0",
  "fast-uri": "^2.4.6 || ^3.1.8 || >=4.1.4",
  "js-yaml": ">=4.3.2",
  "markdown-it": ">=14.3.1",
  nanoid: "^3.3.18 || >=5.1.16",
  orval: ">=8.22.0",
  postcss: ">=8.5.23",
  sharp: ">=0.35.4",
  "smol-toml": ">=1.7.1",
  svgo: ">=4.1.0",
  undici: "^6.28.1 || ^7.29.1 || >=8.10.2",
};

function versionsFor(entries, name) {
  assert.ok(entries && typeof entries === "object", "missing pnpm lockfile section");
  return Object.keys(entries)
    .filter((key) => key.startsWith(`${name}@`))
    .map((key) => key.slice(name.length + 1).split("(")[0]);
}

function assertSafe(name, version) {
  assert.ok(semver.valid(version), `unrecognized ${name} version: ${version}`);
  assert.ok(
    semver.satisfies(version, safeVersions[name]),
    `${name}@${version} is vulnerable; expected ${safeVersions[name]}`,
  );
}

for (const name of Object.keys(safeVersions)) {
  test(`every locked ${name} copy is patched, including peer-specific snapshots`, () => {
    for (const section of ["packages", "snapshots"]) {
      const versions = versionsFor(lock[section], name);
      assert.ok(versions.length > 0, `${name} missing from lockfile ${section}`);
      for (const version of versions) assertSafe(name, version);
    }
  });
}

test("Sharp's native packages include patched binaries on every locked platform", () => {
  for (const section of ["packages", "snapshots"]) {
    const binaries = Object.keys(lock[section]).filter((key) => key.startsWith("@img/sharp-"));
    assert.ok(binaries.length > 0, `native Sharp packages missing from ${section}`);
    for (const key of binaries) {
      const packageKey = key.split("(")[0];
      const version = packageKey.slice(packageKey.lastIndexOf("@") + 1);
      const floor = key.startsWith("@img/sharp-libvips-") ? "1.3.3" : "0.35.4";
      assert.ok(semver.gte(version, floor), `${key} predates the patched libheif bundle`);
    }
  }
});

test("workspace overrides cannot reintroduce an old vulnerable transitive", () => {
  assert.deepEqual(lock.overrides, workspace.overrides, "lockfile overrides are stale");
  for (const [selector, version] of Object.entries(workspace.overrides)) {
    for (const name of Object.keys(safeVersions)) {
      if (selector === name || selector.startsWith(`${name}@`) || selector.endsWith(`>${name}`)) {
        assertSafe(name, version);
      }
    }
  }
});

test("desktop, landing, coverage and Vitest internals stay on one patched version", () => {
  const desktop = JSON.parse(read("packages/desktop/package.json"));
  const landing = JSON.parse(read("packages/landing/package.json"));
  const version = desktop.devDependencies.vitest;
  assert.ok(semver.satisfies(version, ">=4.1.11"));
  assert.equal(desktop.devDependencies["@vitest/coverage-v8"], version);
  assert.equal(landing.devDependencies.vitest, version);
  for (const key of Object.keys(lock.packages)) {
    if (key.startsWith("@vitest/") || key.startsWith("vitest@")) {
      assert.equal(key.slice(key.lastIndexOf("@") + 1), version, `${key} is out of sync`);
    }
  }
});

test("Orval and its @orval packages stay on one patched release", () => {
  const desktop = JSON.parse(read("packages/desktop/package.json"));
  const version = desktop.devDependencies.orval;
  assert.ok(semver.satisfies(version, safeVersions.orval));
  for (const section of ["packages", "snapshots"]) {
    let packageCount = 0;
    for (const key of Object.keys(lock[section])) {
      const packageName = key.match(/^(@orval\/[^@]+)@/)?.[1];
      if (packageName) {
        packageCount += 1;
        assert.equal(
          key.slice(packageName.length + 1).split("(")[0],
          version,
          `${key} is out of sync with orval@${version}`,
        );
      }
    }
    assert.ok(packageCount > 0, `@orval packages missing from lockfile ${section}`);
  }
});

test("the gate detects vulnerable nested copies even when a direct copy is patched", () => {
  const entries = {
    "postcss@8.5.23": {},
    "postcss@8.5.18": {},
    "@vitest/mocker@4.1.9(vite@6.4.3)": {},
  };
  assert.deepEqual(versionsFor(entries, "postcss"), ["8.5.23", "8.5.18"]);
  assert.throws(() => assertSafe("postcss", versionsFor(entries, "postcss")[1]), /vulnerable/);
  assert.throws(
    () => assertSafe("@vitest/mocker", versionsFor(entries, "@vitest/mocker")[0]),
    /vulnerable/,
  );
});
