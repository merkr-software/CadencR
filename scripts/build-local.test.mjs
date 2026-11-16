import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { localBuildEnv } from "./build-local.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { publicKey } = generateKeyPairSync("ed25519");
const feed = "https://raw.githubusercontent.com/test/registry/refs/heads/marketplace-v2/";
const configured = {
  CADENCR_REGISTRY_TRUST_MANIFEST_JSON: JSON.stringify({
    signed: { schema_version: 1, kind: "registry-trust", generation: 2 },
  }),
  CADENCR_REGISTRY_ROOT_KEY_ID: "test-root",
  CADENCR_REGISTRY_ROOT_PUBLIC_KEY_BASE64: publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("base64"),
  CADENCR_REGISTRY_TRUST_MIN_GENERATION: "2",
  CADENCR_MANAGED_PROVIDER_INDEX_URL: `${feed}managed-index.json`,
  CADENCR_MANAGED_PROVIDER_BLOCKLIST_URL: `${feed}managed-blocklist.json`,
  CADENCR_MANAGED_THEME_INDEX_URL: `${feed}managed-index.json`,
  CADENCR_MANAGED_THEME_BLOCKLIST_URL: `${feed}managed-theme-blocklist.json`,
  CADENCR_MANAGED_LSP_BLOCKLIST_URL: `${feed}managed-lsp-blocklist.json`,
  CADENCR_MANAGED_TAB_BLOCKLIST_URL: `${feed}managed-tab-blocklist.json`,
  CADENCR_SENTRY_DSN: "https://public@example.invalid/42",
  CADENCR_POSTHOG_KEY: "phc_public-test-key",
  CADENCR_POSTHOG_HOST: "https://eu.i.posthog.com",
};
const variables = (env = configured) =>
  Object.entries(env).map(([name, value]) => ({ name, value }));

test("GitHub build values replace stale exports without importing unrelated variables or secrets", () => {
  const base = {
    PATH: "/usr/bin",
    CADENCR_MANAGED_PROVIDER_KEY_ID: "obsolete-legacy-pin",
    CADENCR_POSTHOG_KEY: "stale",
  };
  const env = localBuildEnv(
    variables({
      ...configured,
      SENTRY_AUTH_TOKEN: "do-not-import",
      CADENCR_AUTH_TOKEN: "do-not-import",
      CADENCR_POSTHOG_KEY_EXTRA: "do-not-import",
      "CADENCR_MANAGED_BAD;name": "do-not-import",
    }),
    base,
  );
  assert.deepEqual(env, { PATH: base.PATH, ...configured });
  assert.equal(base.CADENCR_POSTHOG_KEY, "stale");
});

test("missing or blank telemetry cannot be filled from old shell exports", () => {
  for (const name of ["CADENCR_SENTRY_DSN", "CADENCR_POSTHOG_KEY", "CADENCR_POSTHOG_HOST"]) {
    const partial = { ...configured };
    delete partial[name];
    for (const input of [partial, { ...partial, [name]: "   " }]) {
      assert.throws(() => localBuildEnv(variables(input), configured), new RegExp(name));
    }
  }
});

test("absent configuration disables every build feature even with stale shell exports", () => {
  const base = { ...configured, CADENCR_MANAGED_OLD_PIN: "old-pin", PATH: "/usr/bin" };
  for (const input of [
    [],
    variables({ UNRELATED: "value" }),
    variables({ CADENCR_POSTHOG_KEY: " " }),
  ]) {
    assert.deepEqual(localBuildEnv(input, base), { PATH: "/usr/bin" });
  }
  assert.equal(base.CADENCR_POSTHOG_KEY, configured.CADENCR_POSTHOG_KEY);
});

test("malformed responses and incomplete marketplace configuration fail before a build", () => {
  for (const input of [null, {}, [null], [{ name: "CADENCR_POSTHOG_KEY", value: 42 }]]) {
    assert.throws(() => localBuildEnv(input, {}), /invalid repository variable list/);
  }
  const partial = { ...configured };
  delete partial.CADENCR_REGISTRY_ROOT_KEY_ID;
  assert.throws(() => localBuildEnv(variables(partial), configured), /configured together/);
  assert.throws(
    () => localBuildEnv(variables({ ...configured, CADENCR_POSTHOG_KEY: " key " }), {}),
    /surrounding whitespace/,
  );
});

test("malformed telemetry URLs are rejected before claiming a configured build", () => {
  const invalid = {
    CADENCR_SENTRY_DSN: [
      "invalid",
      "http://public@example.invalid/42",
      "https://example.invalid/42",
      "https://public:password@example.invalid/42",
      "https://public:@example.invalid/42",
      "https://public@example.invalid/project",
      "https://public@example.invalid/42?",
      "https://public@example.invalid/42#",
      `https://${"x".repeat(129)}@example.invalid/42`,
    ],
    CADENCR_POSTHOG_HOST: [
      "invalid",
      "http://eu.i.posthog.com",
      "https://user@eu.i.posthog.com",
      "https://user:password@eu.i.posthog.com",
      "https://eu.i.posthog.com/capture",
      "https://eu.i.posthog.com?key=private",
      "https://eu.i.posthog.com#",
    ],
  };
  for (const [name, values] of Object.entries(invalid)) {
    for (const value of values) {
      assert.throws(() => localBuildEnv(variables({ ...configured, [name]: value }), {}), {
        message: new RegExp(name),
      });
    }
  }
  const selfHosted = {
    ...configured,
    CADENCR_SENTRY_DSN: "https://public-key@sentry.example.invalid:8443/prefix/42/",
    CADENCR_POSTHOG_HOST: "https://posthog.example.invalid:8443/",
  };
  assert.deepEqual(localBuildEnv(variables(selfHosted), {}), selfHosted);
});

function fixture(t, values = configured) {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-local-build-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, "build.json");
  const source = join(dir, "variables.json");
  symlinkSync(process.execPath, join(dir, "node"));
  writeFileSync(source, JSON.stringify(variables(values)));
  const writeCommand = (name, code) =>
    writeFileSync(join(dir, name), `#!/usr/bin/env node\n${code}`, { mode: 0o755 });
  writeCommand(
    "gh",
    `
    const fs = require("node:fs");
    fs.writeFileSync(process.env.FIXTURE_GH_ARGS, JSON.stringify(process.argv.slice(2)));
    if (process.env.FIXTURE_GH_FAIL) process.exit(4);
    process.stdout.write(fs.readFileSync(process.env.FIXTURE_VARIABLES));
  `,
  );
  for (const command of ["turbo", "pnpm"]) {
    writeCommand(
      command,
      `
      const fs = require("node:fs");
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("CADENCR_")));
      fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({
        command: ${JSON.stringify(command)}, args: process.argv.slice(2), env,
        target: process.env.CARGO_TARGET_DIR, cwd: process.cwd()
      }));
      process.exit(Number(process.env.FIXTURE_BUILD_EXIT || 0));
    `,
    );
  }
  const env = {
    PATH: `${dir}:${dirname(process.execPath)}:${process.env.PATH}`,
    FIXTURE_VARIABLES: source,
    FIXTURE_CAPTURE: capture,
    FIXTURE_GH_ARGS: join(dir, "gh-args.json"),
  };
  return {
    binDir: dir,
    capture,
    source,
    env,
    run: (args = [], extraEnv = {}) =>
      spawnSync(process.execPath, [join(repoRoot, "scripts/build-local.mjs"), ...args], {
        // Running elsewhere must still build the intended worktree.
        cwd: dir,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
        timeout: 10_000,
      }),
  };
}

test("macOS and Linux build routes receive literal configuration through the Cargo wrapper", (t) => {
  const literal = "quotes ' \" and $(exit 93) `exit 94`\nsecond line";
  const setup = fixture(t, { ...configured, CADENCR_MANAGED_TEST_LITERAL: literal });
  for (const [args, command, expectedArgs] of [
    [["--force"], "turbo", ["run", "build:local", "--filter=@cadencr/desktop", "--force"]],
    [["--linux"], "pnpm", ["--filter", "@cadencr/desktop", "build:local:linux"]],
  ]) {
    const result = setup.run(args);
    assert.equal(result.status, 0, result.stderr);
    const built = JSON.parse(readFileSync(setup.capture, "utf8"));
    assert.equal(built.command, command);
    assert.deepEqual(built.args, expectedArgs);
    for (const [key, value] of Object.entries(configured)) assert.equal(built.env[key], value);
    assert.equal(built.env.CADENCR_MANAGED_TEST_LITERAL, literal);
    assert.equal(built.target, join(repoRoot, "target"));
    assert.equal(built.cwd, repoRoot);
    assert.ok(!result.stdout.includes(configured.CADENCR_POSTHOG_KEY));
  }
  assert.deepEqual(JSON.parse(readFileSync(setup.env.FIXTURE_GH_ARGS, "utf8")), [
    "variable",
    "list",
    "--repo",
    "merkr-software/CadencR",
    "--json",
    "name,value",
  ]);
});

test("configuration checks validate both routes without invoking a build", (t) => {
  const setup = fixture(t);
  for (const args of [["--check-config"], ["--linux", "--check-config"]]) {
    const result = setup.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No build started/);
    assert.equal(existsSync(setup.capture), false);
  }
});

test("GitHub failure or denied access falls back on both build routes without inherited feature values", (t) => {
  const setup = fixture(t);
  for (const args of [[], ["--linux"]]) {
    const result = setup.run(args, { ...configured, FIXTURE_GH_FAIL: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /GitHub build variables are unavailable/);
    assert.match(result.stderr, /telemetry are disabled/);
    const built = JSON.parse(readFileSync(setup.capture, "utf8"));
    assert.deepEqual(built.env, {});
  }
});

test("missing gh also falls back without needing a GitHub account", (t) => {
  const setup = fixture(t);
  rmSync(join(setup.binDir, "gh"));
  const result = setup.run([], { ...configured, PATH: setup.binDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /gh\) is not installed/);
  assert.deepEqual(JSON.parse(readFileSync(setup.capture, "utf8")).env, {});
});

test("an empty GitHub configuration builds with features disabled", (t) => {
  const setup = fixture(t, {});
  const result = setup.run([], configured);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No GitHub build variables/);
  assert.deepEqual(JSON.parse(readFileSync(setup.capture, "utf8")).env, {});
});

test("configuration checks report the fallback without starting a build", (t) => {
  const setup = fixture(t);
  const result = setup.run(["--check-config"], { ...configured, FIXTURE_GH_FAIL: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /telemetry are disabled/);
  assert.match(result.stdout, /No build started/);
  assert.equal(existsSync(setup.capture), false);
});

test("malformed or partially configured GitHub responses still stop before a build", (t) => {
  const setup = fixture(t);
  writeFileSync(setup.source, "invalid-json-response");
  const malformed = setup.run();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /invalid JSON/);
  assert.ok(!malformed.stderr.includes("invalid-json-response"));
  writeFileSync(
    setup.source,
    JSON.stringify(variables({ ...configured, CADENCR_POSTHOG_KEY: "" })),
  );
  const missing = setup.run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CADENCR_POSTHOG_KEY/);
  writeFileSync(
    setup.source,
    JSON.stringify(variables({ ...configured, CADENCR_SENTRY_DSN: "private-invalid-value" })),
  );
  const invalid = setup.run(["--check-config"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /CADENCR_SENTRY_DSN/);
  assert.ok(!invalid.stderr.includes("private-invalid-value"));
  assert.ok(!invalid.stdout.includes("configuration is valid"));
  assert.equal(existsSync(setup.capture), false);
});

test("the wrapper preserves a failed build's exit status", (t) => {
  const setup = fixture(t);
  assert.equal(setup.run([], { FIXTURE_BUILD_EXIT: "17" }).status, 17);
  assert.equal(setup.run([], { FIXTURE_GH_FAIL: "1", FIXTURE_BUILD_EXIT: "18" }).status, 18);
});
