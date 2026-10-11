import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  TRUST_ENV,
  GENERATION_ENV,
  MIN_GENERATION_ENV,
  THEME_ENV,
  THEME_POLICY_ENV,
  validatedBuildEnv,
} from "./validate-marketplace-build-env.mjs";

function configured() {
  const { publicKey } = generateKeyPairSync("ed25519");
  const bytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Object.fromEntries(
    TRUST_ENV.map((name, index) => [
      name,
      [
        "test-build-key",
        bytes.toString("base64"),
        "https://raw.githubusercontent.com/test-fixture/registry/refs/heads/catalog/managed-index.json",
        "https://example.invalid/blocklist.json",
      ][index],
    ]),
  );
}
const mixed =
  "https://raw.githubusercontent.com/test-fixture/registry/refs/heads/marketplace-v2/managed-index.json";

const policy = mixed.replace("managed-index.json", "managed-theme-blocklist.json");

test("unconfigured releases omit empty compile-time trust values and retain ordinary env", () => {
  const env = validatedBuildEnv({
    ...Object.fromEntries(
      [...TRUST_ENV, ...GENERATION_ENV, MIN_GENERATION_ENV, THEME_ENV, THEME_POLICY_ENV].map(
        (name) => [name, ""],
      ),
    ),
    SENTINEL: "keep",
  });
  assert.deepEqual(env, { SENTINEL: "keep" });
});
test("legacy complete configuration remains supported; themes share the exact pinned key", () => {
  const legacy = configured();
  assert.deepEqual(validatedBuildEnv(legacy), legacy);
  const shared = {
    ...legacy,
    [THEME_ENV]: mixed,
    [THEME_POLICY_ENV]: policy,
    [TRUST_ENV[2]]: mixed,
  };
  assert.deepEqual(validatedBuildEnv(shared), shared);
});
test("every partial trust group and unpaired theme feed fails closed", () => {
  const valid = configured();
  for (const missing of TRUST_ENV) {
    const env = { ...valid };
    delete env[missing];
    assert.throws(() => validatedBuildEnv(env), /configured together/);
  }
  assert.throws(() => validatedBuildEnv({ [THEME_ENV]: mixed }), /complete shared/);
});
test("invalid key IDs, key bytes, unsafe feeds and schema1 theme feeds are rejected", () => {
  for (const id of ["-bad", " ", "a".repeat(129)])
    assert.throws(() => validatedBuildEnv({ ...configured(), [TRUST_ENV[0]]: id }));
  for (const key of ["garbage", Buffer.alloc(31).toString("base64")])
    assert.throws(() => validatedBuildEnv({ ...configured(), [TRUST_ENV[1]]: key }));
  for (const url of [
    "http://example.invalid/x",
    "https://user@example.invalid/x",
    "https://example.invalid/x?token=secret",
  ]) {
    assert.throws(() => validatedBuildEnv({ ...configured(), [TRUST_ENV[2]]: url }));
  }
  for (const url of [
    "https://example.invalid/marketplace-v2.json",
    mixed.replace("marketplace-v2", "catalog"),
    `${mixed}?token=secret`,
  ]) {
    assert.throws(() =>
      validatedBuildEnv({ ...configured(), [THEME_ENV]: url, [THEME_POLICY_ENV]: policy }),
    );
  }
});
test("command wrapper forwards configured env and removes blank option_env pins", () => {
  const env = { ...process.env, ...configured(), [THEME_ENV]: mixed, [THEME_POLICY_ENV]: policy };
  const code = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([...TRUST_ENV, ...GENERATION_ENV, MIN_GENERATION_ENV, THEME_ENV, THEME_POLICY_ENV])}.map(k=>[k,process.env[k]??null]))))`;
  const result = spawnSync(
    process.execPath,
    ["scripts/validate-marketplace-build-env.mjs", "--", process.execPath, "-e", code],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[THEME_ENV], mixed);
  for (const name of [
    ...TRUST_ENV,
    ...GENERATION_ENV,
    MIN_GENERATION_ENV,
    THEME_ENV,
    THEME_POLICY_ENV,
  ])
    env[name] = "";
  const empty = spawnSync(
    process.execPath,
    ["scripts/validate-marketplace-build-env.mjs", "--", process.execPath, "-e", code],
    { env, encoding: "utf8" },
  );
  assert.equal(empty.status, 0, empty.stderr);
  assert.ok(Object.values(JSON.parse(empty.stdout)).every((value) => value === null));
});
test("desktop release forwards all public pins and validates before sidecar compilation", () => {
  const text = readFileSync(".github/workflows/desktop-release.yml", "utf8");
  for (const name of [
    ...TRUST_ENV,
    ...GENERATION_ENV,
    MIN_GENERATION_ENV,
    THEME_ENV,
    THEME_POLICY_ENV,
  ])
    assert.ok(text.includes(`${name}: \${{ vars.${name} }}`));
  assert.ok(
    text.includes(
      "node scripts/validate-marketplace-build-env.mjs -- pnpm --filter @cadencr/service build",
    ),
  );
  assert.ok(
    text.indexOf("Validate marketplace build configuration") <
      text.indexOf("Build Rust service sidecar"),
  );
  assert.ok(!text.includes("PRIVATE_KEY"));
});

test("theme catalog and domain-bound revocation feed are an inseparable activation pair", () => {
  const base = configured();
  assert.throws(() => validatedBuildEnv({ ...base, [THEME_ENV]: mixed }), /configured together/);
  assert.throws(
    () => validatedBuildEnv({ ...base, [THEME_POLICY_ENV]: policy }),
    /configured together/,
  );
  for (const url of [
    policy.replace("marketplace-v2", "catalog"),
    `${policy}?token=x`,
    policy.replace("test-fixture", "other-fixture"),
    mixed,
  ]) {
    assert.throws(() =>
      validatedBuildEnv({ ...base, [THEME_ENV]: mixed, [THEME_POLICY_ENV]: url }),
    );
  }
});

function generationConfigured() {
  const legacy = configured();
  return {
    [GENERATION_ENV[0]]: JSON.stringify({
      signed: { schema_version: 1, kind: "registry-trust", generation: 2 },
    }),
    [GENERATION_ENV[1]]: "offline-root",
    [GENERATION_ENV[2]]: legacy[TRUST_ENV[1]],
    [MIN_GENERATION_ENV]: "2",
    [TRUST_ENV[2]]: mixed,
    [TRUST_ENV[3]]: legacy[TRUST_ENV[3]],
    [THEME_ENV]: mixed,
    [THEME_POLICY_ENV]: policy,
  };
}
test("root-authorized generation configuration replaces legacy trust without activating placeholders", () => {
  const env = generationConfigured();
  assert.deepEqual(validatedBuildEnv(env), env);
  for (const missing of GENERATION_ENV) {
    const partial = { ...env };
    delete partial[missing];
    assert.throws(() => validatedBuildEnv(partial), /configured together/);
  }
  assert.throws(() => validatedBuildEnv({ ...env, ...configured() }), /not both/);
  assert.throws(() => validatedBuildEnv({ [MIN_GENERATION_ENV]: "1" }), /requires offline root/);
  for (const minimum of ["0", "-1", "x", "18446744073709551616", "3"])
    assert.throws(() => validatedBuildEnv({ ...env, [MIN_GENERATION_ENV]: minimum }));
  for (const manifest of ["PENDING", "{}", "x".repeat(65537)])
    assert.throws(() => validatedBuildEnv({ ...env, [GENERATION_ENV[0]]: manifest }));
  assert.throws(() => validatedBuildEnv({ ...env, [GENERATION_ENV[2]]: "private-key" }));
});
