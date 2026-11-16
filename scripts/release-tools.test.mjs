import assert from "node:assert/strict";
import test from "node:test";

import {
  TOOLS,
  compareSemver,
  crateVersion,
  pathDependencies,
  releases,
  toolStatus,
  watchedPaths,
} from "./release-tools.mjs";

const tool = (id) => TOOLS.find((candidate) => candidate.id === id);

/** A repository with these files and tags; `changed` maps a base tag to its commits. */
function fakeGit(files, tags, changed = {}) {
  const logged = [];
  return {
    logged,
    show: (path) => {
      if (!(path in files)) throw new Error(`no ${path}`);
      return files[path];
    },
    tags: () => tags,
    log: (base, paths) => {
      logged.push({ base, paths });
      return changed[base] ?? [];
    },
  };
}

const cliFiles = (version, { npm = version, locked = version } = {}) => ({
  "packages/cli/Cargo.toml": `[package]\nname = "cadencr-cli"\nversion = "${version}"\n\n[[bin]]\npath = "src/main.rs"\n\n[dependencies]\ncadencr-plugin-core = { path = "../plugin-core" }\ncadencr-tab-backend = { path = "../tab-backend-sdk-rs", features = ["conformance"] }\n\n[dev-dependencies]\ncadencr-test = { path = "../test-only" }\n`,
  "packages/cli/package.json": JSON.stringify({ version: npm }),
  "packages/plugin-core/Cargo.toml": `[package]\nversion = "0.14.0"\n`,
  "packages/tab-backend-sdk-rs/Cargo.toml": `[package]\nversion = "0.1.0"\n\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\n`,
  "Cargo.lock": `[[package]]\nname = "cadencr-cli"\nversion = "${locked}"\n`,
});

test("semver sorts numerically, a pre-release before its release", () => {
  assert.ok(compareSemver("0.10.0", "0.9.9") > 0);
  assert.ok(compareSemver("1.0.0-beta.1", "1.0.0") < 0);
  assert.equal(compareSemver("0.1.0", "0.1.0"), 0);
});

test("reads the package version and only the shipped path dependencies", () => {
  const manifest = cliFiles("0.15.0")["packages/cli/Cargo.toml"];
  assert.equal(crateVersion(manifest), "0.15.0");
  assert.deepEqual(pathDependencies(manifest), ["../plugin-core", "../tab-backend-sdk-rs"]);
  assert.deepEqual(
    pathDependencies(`[target.'cfg(unix)'.build-dependencies]\nx = { path = "../x" }\n`),
    ["../x"],
  );
});

test("the CLI watches its path dependencies, its lockfile and toolchain", () => {
  const git = fakeGit(cliFiles("0.15.0"), []);
  assert.deepEqual(watchedPaths(tool("cli"), git), [
    "packages/cli",
    "packages/plugin-core",
    "packages/tab-backend-sdk-rs",
    "Cargo.lock",
    "rust-toolchain.toml",
  ]);
  assert.deepEqual(watchedPaths(tool("tab-kit"), git), [
    "packages/tab-kit",
    "scripts/vendor-tab-packages.mjs",
  ]);
});

test("CLI releases are its own tags and the app releases that carried it", () => {
  const tags = ["v0.13.1", "v0.14.0", "v0.15.0", "cli/v0.13.1-dev.38947325650.1", "cli/v0.15.0"];
  assert.deepEqual(
    releases(tool("cli"), tags).map((release) => release.tag),
    ["v0.13.1", "v0.14.0", "cli/v0.15.0"],
  );
  assert.deepEqual(releases(tool("tab-sdk"), ["tab-sdk-v0.2.0", "tab-sdk-v0.10.0", "v0.1.0"]), [
    { tag: "tab-sdk-v0.2.0", version: "0.2.0" },
    { tag: "tab-sdk-v0.10.0", version: "0.10.0" },
  ]);
});

test("a released version with changes since needs a bump; without, it is up to date", () => {
  const commit = { sha: "abc1234", subject: "feat(cli): something" };
  const changed = fakeGit(cliFiles("0.14.0"), ["v0.14.0"], { "v0.14.0": [commit] });
  const status = toolStatus(tool("cli"), changed);
  assert.equal(status.state, "needs-bump");
  assert.equal(status.released, "v0.14.0");
  assert.deepEqual(status.commits, [commit]);
  assert.equal(changed.logged[0].base, "v0.14.0");
  assert.equal(
    toolStatus(tool("cli"), fakeGit(cliFiles("0.14.0"), ["v0.14.0"])).state,
    "up-to-date",
  );
});

test("a bumped version is ready, compared with the last release; a new tool is a first release", () => {
  const git = fakeGit(cliFiles("0.15.0"), ["v0.14.0"], {
    "v0.14.0": [{ sha: "abc1234", subject: "fix(cli): x" }],
  });
  const ready = toolStatus(tool("cli"), git);
  assert.equal(ready.state, "ready");
  assert.equal(ready.released, null);
  assert.equal(ready.baseline, "v0.14.0");
  assert.equal(ready.commits.length, 1);

  const sdk = fakeGit(
    {
      "packages/tab-sdk/package.json": JSON.stringify({ version: "0.1.0" }),
      "packages/tab-sdk/src/version.ts": `export const SDK_VERSION = "0.1.0";\n`,
    },
    [],
  );
  const first = toolStatus(tool("tab-sdk"), sdk);
  assert.equal(first.state, "first-release");
  assert.equal(first.commits, null);
  assert.deepEqual(first.problems, []);
});

test("version records that disagree are reported", () => {
  const cli = toolStatus(
    tool("cli"),
    fakeGit(cliFiles("0.15.0", { npm: "0.14.0", locked: "0.14.0" }), []),
  );
  assert.deepEqual(cli.problems, [
    "package.json is 0.14.0, Cargo.toml 0.15.0",
    "Cargo.lock is 0.14.0, Cargo.toml 0.15.0",
  ]);
  const sdk = toolStatus(
    tool("tab-sdk"),
    fakeGit(
      {
        "packages/tab-sdk/package.json": JSON.stringify({ version: "0.2.0" }),
        "packages/tab-sdk/src/version.ts": `export const SDK_VERSION = "0.1.0";\n`,
      },
      [],
    ),
  );
  assert.deepEqual(sdk.problems, ["SDK_VERSION is 0.1.0, package.json 0.2.0"]);
});
