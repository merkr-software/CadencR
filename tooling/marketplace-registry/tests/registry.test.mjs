import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  comparePackages,
  validateIndex,
  validatePackage,
  validateSignedIndex,
} from "../scripts/lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const existingFixture = path.join(root, "tests/fixtures/valid.json.fixture");
const existingSigningFixture = path.join(root, "tests/fixtures/valid.signing.json.fixture");

async function fixture() {
  return JSON.parse(await readFile(existingFixture, "utf8"));
}

test("accepts the service's exact managed index v1 fixture", async () => {
  assert.deepEqual(
    validateSignedIndex(await fixture(), { now: new Date("2026-09-12T00:00:00Z") }),
    [],
  );
});

test("canonical bytes match the service signing fixture", async () => {
  const envelope = await fixture();
  const expected = (await readFile(existingSigningFixture, "utf8")).trimEnd();
  assert.equal(canonicalJson(envelope.signed), expected);
});

test("rejects credentials, escaping paths, reserved arguments, and unknown host fields", async () => {
  const cases = [
    (entry) => {
      entry.agent.distribution.binary["darwin-aarch64"].env = { API_TOKEN: "secret" };
    },
    (entry) => {
      entry.host.assets.icon = "../icon.svg";
    },
    (entry) => {
      entry.agent.distribution.binary["darwin-aarch64"].args = ["--protocol=acp-v2"];
    },
    (entry) => {
      entry.host.credentials = "never";
    },
  ];
  for (const mutate of cases) {
    const envelope = await fixture();
    mutate(envelope.signed.packages[0]);
    assert.notDeepEqual(
      validateSignedIndex(envelope, { now: new Date("2026-09-12T00:00:00Z") }),
      [],
    );
  }
});

test("requires deterministic id and semantic-version order", async () => {
  const envelope = await fixture();
  const older = structuredClone(envelope.signed.packages[0]);
  older.agent.version = "1.0.0";
  envelope.signed.packages.push(older);
  const now = new Date("2026-09-12T00:00:00Z");
  assert.ok(validateIndex(envelope.signed, { now }).some((error) => error.includes("sorted")));
  envelope.signed.packages.sort(comparePackages);
  assert.deepEqual(validateIndex(envelope.signed, { now }), []);
});

test("matches SemVer 2 validation and prerelease precedence used by the service", async () => {
  const envelope = await fixture();
  const base = envelope.signed.packages[0];
  const versions = [
    "1.0.0-2",
    "1.0.0-10",
    "1.0.0-999999999999999999999999999999",
    "1.0.0-alpha",
    "1.0.0",
  ];
  envelope.signed.packages = versions.map((version) => {
    const entry = structuredClone(base);
    entry.agent.version = version;
    return entry;
  });
  envelope.signed.packages.sort(comparePackages);
  assert.deepEqual(
    envelope.signed.packages.map((entry) => entry.agent.version),
    ["1.0.0-2", "1.0.0-10", "1.0.0-999999999999999999999999999999", "1.0.0-alpha", "1.0.0"],
  );
  const now = new Date("2026-09-12T00:00:00Z");
  assert.deepEqual(validateIndex(envelope.signed, { now }), []);

  for (const version of ["1.0.0-01", "1.0.0-alpha..1", "1.0.0+build..1"]) {
    const entry = structuredClone(base);
    entry.agent.version = version;
    assert.ok(validatePackage(entry).some((error) => error.includes("semantic version")));
  }
});

test("compares SemVer core identifiers exactly and enforces Rust u64 bounds", async () => {
  const envelope = await fixture();
  const base = envelope.signed.packages[0];
  envelope.signed.packages = ["9007199254740993.0.0", "9007199254740992.0.0"].map((version) => {
    const entry = structuredClone(base);
    entry.agent.version = version;
    return entry;
  });
  envelope.signed.packages.sort(comparePackages);
  assert.deepEqual(
    envelope.signed.packages.map((entry) => entry.agent.version),
    ["9007199254740992.0.0", "9007199254740993.0.0"],
  );

  for (const version of [
    "18446744073709551616.0.0",
    "0.18446744073709551616.0",
    "0.0.18446744073709551616",
  ]) {
    const entry = structuredClone(base);
    entry.agent.version = version;
    assert.ok(validatePackage(entry).some((error) => error.includes("semantic version")));
  }
});

test("requires binary delivery and validates package-runner argument types", async () => {
  const envelope = await fixture();
  const entry = envelope.signed.packages[0];
  entry.agent.distribution.npx = { package: "example", args: { invalid: true } };
  assert.ok(validatePackage(entry).some((error) => error.includes("array of strings")));

  delete entry.agent.distribution.binary;
  entry.agent.distribution.npx = { package: "example", args: [] };
  assert.ok(validatePackage(entry).some((error) => error.includes("binary")));
});

test("public JSON Schema requires the same managed binary delivery as semantic validation", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "schemas/managed-provider-package-v1.schema.json"), "utf8"),
  );
  assert.deepEqual(schema.$defs.distribution.required, ["binary"]);
  assert.equal(schema.$defs.distribution.anyOf, undefined);
});

test("enforces the exact bounded publication window", async () => {
  const envelope = await fixture();
  const now = new Date("2026-09-12T00:00:00Z");
  envelope.signed.expires_at = "2026-09-27T00:00:01Z";
  assert.ok(validateIndex(envelope.signed, { now }).some((error) => error.includes("14 days")));
  envelope.signed.expires_at = "2026-09-12T00:00:00Z";
  assert.ok(validateIndex(envelope.signed, { now }).some((error) => error.includes("follow")));
});

test("template contribution is a valid package", async () => {
  const example = JSON.parse(
    await readFile(path.join(root, "tests/fixtures/example-provider.json.fixture"), "utf8"),
  );
  assert.deepEqual(validatePackage(example), []);
});

test("malformed package shapes return diagnostics instead of throwing", async () => {
  const { signed } = await fixture();
  const now = new Date("2026-09-12T00:00:00Z");
  for (const entry of [null, {}, { agent: { id: "a" } }]) {
    assert.ok(validateIndex({ ...signed, packages: [entry] }, { now }).length > 0);
  }
  for (const args of [12, {}, [null], [3]]) {
    const entry = structuredClone(signed.packages[0]);
    entry.agent.distribution.binary["darwin-aarch64"].args = args;
    assert.ok(validatePackage(entry).some((error) => error.includes("array of strings")));
  }
});

test("optional agent fields follow their schema types", async () => {
  for (const [key, value] of [
    ["authors", [3]],
    ["license", 12],
    ["icon", {}],
  ]) {
    const entry = (await fixture()).signed.packages[0];
    entry.agent[key] = value;
    assert.ok(validatePackage(entry).some((error) => error.includes(key)));
  }
});

test("canonical object keys follow Rust UTF-8 ordering, not UTF-16 ordering", () => {
  assert.equal(canonicalJson({ "\u{10000}": 2, "\ue000": 1 }), '{"\ue000":1,"\u{10000}":2}');
});
