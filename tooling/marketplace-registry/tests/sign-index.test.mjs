import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, validateSignedIndex } from "../scripts/lib.mjs";

const cli = fileURLToPath(new URL("../scripts/sign-index.mjs", import.meta.url));
const providerFixture = new URL("fixtures/example-provider.json.fixture", import.meta.url);

function wholeSecondIso(timestamp) {
  return new Date(Math.floor(timestamp / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-sign-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = JSON.parse(await readFile(providerFixture, "utf8"));
  const payload = {
    schema_version: 1,
    generated_at: wholeSecondIso(Date.now() - 60_000),
    expires_at: wholeSecondIso(Date.now() + 24 * 60 * 60 * 1000),
    packages: [provider],
  };
  const payloadFile = path.join(directory, "index.json");
  const privateKeyFile = path.join(directory, "private.pem");
  const outputFile = path.join(directory, "signed.json");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(payloadFile, JSON.stringify(payload));
  await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  return { directory, outputFile, payload, payloadFile, privateKey, privateKeyFile, publicKey };
}

function run({ payloadFile, privateKeyFile, outputFile }, ...extra) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "--payload",
      payloadFile,
      "--private-key",
      privateKeyFile,
      "--key-id",
      "release-2026",
      "--output",
      outputFile,
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

test("signs canonical bytes with Ed25519 and writes a private exclusive envelope", async (t) => {
  const files = await setup(t);
  const result = run(files);
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(await readFile(files.outputFile, "utf8"));
  assert.deepEqual(validateSignedIndex(envelope), []);
  assert.deepEqual(envelope.signed, files.payload);
  assert.deepEqual(envelope.signature.algorithm, "ed25519");
  assert.deepEqual(envelope.signature.key_id, "release-2026");
  const signature = Buffer.from(envelope.signature.value, "base64");
  assert.equal(signature.length, 64);
  assert.equal(
    verify(null, Buffer.from(canonicalJson(envelope.signed)), files.publicKey, signature),
    true,
  );
  assert.equal((await lstat(files.outputFile)).mode & 0o777, 0o600);

  envelope.signed.packages[0].agent.name = "tampered";
  assert.equal(
    verify(null, Buffer.from(canonicalJson(envelope.signed)), files.publicKey, signature),
    false,
  );
});

test("signature exactly matches independent signing of canonical bytes", async (t) => {
  const files = await setup(t);
  assert.equal(run(files).status, 0);
  const envelope = JSON.parse(await readFile(files.outputFile, "utf8"));
  const bytes = Buffer.from(canonicalJson(envelope.signed));
  assert.equal(
    verify(null, bytes, files.publicKey, Buffer.from(envelope.signature.value, "base64")),
    true,
  );
  assert.deepEqual(
    Buffer.from(envelope.signature.value, "base64"),
    sign(null, bytes, files.privateKey),
  );
});

test("rejects wrong algorithms without disclosing key material", async (t) => {
  const files = await setup(t);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(files.privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }));
  const wrongAlgorithm = run(files);
  assert.equal(wrongAlgorithm.status, 1);
  assert.match(wrongAlgorithm.stderr, /Ed25519 PKCS8 PEM/);

  const secretMarker = "DO_NOT_PRINT_PRIVATE_MATERIAL";
  await writeFile(files.privateKeyFile, secretMarker);
  const malformed = run(files);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Ed25519 PKCS8 PEM/);
  assert.doesNotMatch(`${malformed.stdout}${malformed.stderr}`, new RegExp(secretMarker));
});

test("rejects an invalid key id before reading the private key", async (t) => {
  const files = await setup(t);
  const missingKey = path.join(files.directory, "missing-private.pem");
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--payload",
      files.payloadFile,
      "--private-key",
      missingKey,
      "--key-id",
      "invalid key id",
      "--output",
      files.outputFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /signing key id is invalid/);
  assert.doesNotMatch(result.stderr, /private key/);
  await assert.rejects(readFile(files.outputFile), { code: "ENOENT" });
});

test("rejects invalid and expired payload metadata", async (t) => {
  const files = await setup(t);
  for (const mutate of [
    (payload) => {
      payload.schema_version = 2;
    },
    (payload) => {
      payload.generated_at = "2020-01-01T00:00:00Z";
      payload.expires_at = "2020-01-02T00:00:00Z";
    },
  ]) {
    const payload = structuredClone(files.payload);
    mutate(payload);
    await writeFile(files.payloadFile, JSON.stringify(payload));
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /payload validation failed/);
  }
});

test("rejects non-canonical timestamp precision without creating output", async (t) => {
  const files = await setup(t);
  for (const timestamp of [
    "2026-09-19T12:00:00.000Z",
    "2026-09-19T12:00:00.1Z",
    "2026-02-30T12:00:00Z",
    "2026-09-19T24:00:00Z",
  ]) {
    const payload = structuredClone(files.payload);
    payload.generated_at = timestamp;
    await writeFile(files.payloadFile, JSON.stringify(payload));
    const result = run(files);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canonical UTC whole-second form YYYY-MM-DDTHH:mm:ssZ/);
    await assert.rejects(readFile(files.outputFile), { code: "ENOENT" });
  }
});

test("rejects empty optional fields that Rust omits from signing bytes", async (t) => {
  const files = await setup(t);
  const cases = [
    ["authors", (agent) => (agent.authors = [])],
    ["binary args", (agent) => (binaryTarget(agent).args = [])],
    ["binary env", (agent) => (binaryTarget(agent).env = {})],
    ["npx args", (agent) => (agent.distribution.npx = { package: "example", args: [] })],
    ["npx env", (agent) => (agent.distribution.npx = { package: "example", env: {} })],
    ["uvx args", (agent) => (agent.distribution.uvx = { package: "example", args: [] })],
    ["uvx env", (agent) => (agent.distribution.uvx = { package: "example", env: {} })],
  ];
  for (const [label, mutate] of cases) {
    const payload = structuredClone(files.payload);
    mutate(payload.packages[0].agent);
    await writeFile(files.payloadFile, JSON.stringify(payload));
    const result = run(files);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /empty optional field; omit it before signing/, label);
    await assert.rejects(readFile(files.outputFile), { code: "ENOENT" });
  }
});

function binaryTarget(agent) {
  return agent.distribution.binary["darwin-aarch64"];
}

test("refuses overwrite and symbolic-link inputs", async (t) => {
  const files = await setup(t);
  await writeFile(files.outputFile, "keep");
  const overwrite = run(files);
  assert.equal(overwrite.status, 1);
  assert.equal(await readFile(files.outputFile, "utf8"), "keep");

  await rm(files.outputFile);
  const link = path.join(files.directory, "payload-link.json");
  await symlink(files.payloadFile, link);
  const symlinkResult = run({ ...files, payloadFile: link });
  assert.equal(symlinkResult.status, 1);
  assert.match(symlinkResult.stderr, /regular file|cannot read payload/);

  const keyLink = path.join(files.directory, "private-link.pem");
  await symlink(files.privateKeyFile, keyLink);
  const keySymlinkResult = run({ ...files, privateKeyFile: keyLink });
  assert.equal(keySymlinkResult.status, 1);
  assert.match(keySymlinkResult.stderr, /regular file|cannot read private key/);
});

test("enforces strict arguments, regular inputs, and size bounds", async (t) => {
  const files = await setup(t);
  const missing = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage:/);

  for (const extra of [
    ["--unknown", "x"],
    ["--payload", files.payloadFile],
  ]) {
    const result = run(files, ...extra);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage:/);
  }

  const directoryResult = run({ ...files, payloadFile: files.directory });
  assert.equal(directoryResult.status, 1);
  assert.match(directoryResult.stderr, /regular file/);
  await writeFile(files.privateKeyFile, Buffer.alloc(16 * 1024 + 1));
  const oversized = run(files);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /16 KiB/);

  await writeFile(files.privateKeyFile, "unused");
  await writeFile(files.payloadFile, Buffer.alloc(32 * 1024 * 1024 + 1));
  const oversizedPayload = run(files);
  assert.equal(oversizedPayload.status, 1);
  assert.match(oversizedPayload.stderr, /32 MiB/);
});
