import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../scripts/lib.mjs";
import { prepareCatalogSnapshot } from "../scripts/publication/snapshot.mjs";

const fixture = new URL("fixtures/example-provider.json.fixture", import.meta.url);
const now = new Date("2026-09-19T12:00:00Z");

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageValue = JSON.parse(await readFile(fixture, "utf8"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyFile = path.join(directory, "public.pem");
  await writeFile(publicKeyFile, publicKey.export({ format: "pem", type: "spki" }));
  const writeEnvelope = async (name, signed, key = privateKey, keyId = "release-2026") => {
    const envelope = {
      signed,
      signature: {
        algorithm: "ed25519",
        key_id: keyId,
        value: sign(null, Buffer.from(canonicalJson(signed)), key).toString("base64"),
      },
    };
    const file = path.join(directory, name);
    await writeFile(file, `${canonicalJson(envelope)}\n`);
    return { envelope, file };
  };
  const payload = (generated, expires, packages = [structuredClone(packageValue)]) => ({
    schema_version: 1,
    generated_at: generated,
    expires_at: expires,
    packages,
  });
  const options = (catalogFile, previousIndex = "bootstrap") => ({
    catalogFile,
    previousIndex,
    publicKeyFile,
    keyId: "release-2026",
    repository: "cadencr/registry",
    registryCommit: "a".repeat(40),
    now,
  });
  return { directory, packageValue, privateKey, publicKeyFile, writeEnvelope, payload, options };
}

test("creates an exact deterministic bootstrap binding", async (t) => {
  const state = await setup(t);
  const current = await state.writeEnvelope(
    "current.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T12:00:00Z"),
  );
  const result = await prepareCatalogSnapshot(state.options(current.file));
  assert.deepEqual(result.bytes, Buffer.from(`${canonicalJson(current.envelope)}\n`));
  assert.equal(result.size, result.bytes.length);
  assert.equal(result.tag, `catalog-${result.sha256}`);
  assert.equal(result.previousSha256, undefined);
  assert.equal(
    result.body,
    `cadencr-registry-catalog-v1\ncatalog-sha256:${result.sha256}\nregistry-commit:${"a".repeat(40)}\nprevious-sha256:bootstrap`,
  );
  assert.equal(
    result.expectedUrl,
    `https://github.com/cadencr/registry/releases/download/${result.tag}/managed-index.json`,
  );
});

test("accepts a valid expired baseline and a fresh newer candidate", async (t) => {
  const state = await setup(t);
  const baseline = await state.writeEnvelope(
    "old.json",
    state.payload("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
  );
  const candidate = await state.writeEnvelope(
    "new.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z"),
  );
  const result = await prepareCatalogSnapshot(state.options(candidate.file, baseline.file));
  assert.match(result.previousSha256, /^[0-9a-f]{64}$/);
});

test("rejects tampering, wrong keys, and key id mismatches", async (t) => {
  const state = await setup(t);
  const current = await state.writeEnvelope(
    "current.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z"),
  );
  current.envelope.signed.packages[0].agent.name = "tampered";
  await writeFile(current.file, JSON.stringify(current.envelope));
  await assert.rejects(
    prepareCatalogSnapshot(state.options(current.file)),
    /signature verification/,
  );

  const valid = await state.writeEnvelope(
    "valid.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z"),
  );
  const other = generateKeyPairSync("ed25519");
  await writeFile(state.publicKeyFile, other.publicKey.export({ format: "pem", type: "spki" }));
  await assert.rejects(prepareCatalogSnapshot(state.options(valid.file)), /signature verification/);

  const wrongId = await state.writeEnvelope(
    "wrong-id.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z"),
    state.privateKey,
    "other-key",
  );
  await writeFile(
    state.publicKeyFile,
    generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }),
  );
  await assert.rejects(
    prepareCatalogSnapshot(state.options(wrongId.file)),
    /key id does not match/,
  );
  await writeFile(
    state.publicKeyFile,
    generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      format: "pem",
      type: "spki",
    }),
  );
  await assert.rejects(prepareCatalogSnapshot(state.options(valid.file)), /Ed25519 SPKI/);
});

test("rejects equal/backward time, retained-package removal, mutation, and owner changes", async (t) => {
  const state = await setup(t);
  const olderVersion = structuredClone(state.packageValue);
  olderVersion.agent.version = "0.0.1";
  const baseline = await state.writeEnvelope(
    "old.json",
    state.payload("2026-09-19T10:00:00Z", "2026-09-20T00:00:00Z", [
      olderVersion,
      state.packageValue,
    ]),
  );
  for (const [name, generated, mutate, pattern] of [
    ["equal", "2026-09-19T10:00:00Z", () => {}, /strictly increase/],
    ["backward", "2026-09-19T09:00:00Z", () => {}, /strictly increase/],
    ["removed", "2026-09-19T11:00:00Z", (packages) => packages.splice(0, 1), /removes previous/],
    [
      "mutated",
      "2026-09-19T11:00:00Z",
      (packages) => (packages[1].agent.name = "Changed"),
      /mutates previous/,
    ],
    [
      "owner",
      "2026-09-19T11:00:00Z",
      (packages) => {
        const next = structuredClone(packages[1]);
        next.agent.version = "99.0.0";
        next.host.publisher = "other";
        packages.push(next);
      },
      /changes publisher or source ownership/,
    ],
  ]) {
    const packages = [structuredClone(olderVersion), structuredClone(state.packageValue)];
    mutate(packages);
    const candidate = await state.writeEnvelope(
      `${name}.json`,
      state.payload(generated, "2026-09-20T00:00:00Z", packages),
    );
    await assert.rejects(
      prepareCatalogSnapshot(state.options(candidate.file, baseline.file)),
      pattern,
    );
  }
});

test("rejects conflicting owners across versions in bootstrap mode", async (t) => {
  const state = await setup(t);
  const next = structuredClone(state.packageValue);
  next.agent.version = "99.0.0";
  next.host.publisher = "other";
  const candidate = await state.writeEnvelope(
    "owners.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z", [state.packageValue, next]),
  );
  await assert.rejects(
    prepareCatalogSnapshot(state.options(candidate.file)),
    /conflicting publisher or source ownership/,
  );
});

test("allows an expired baseline but rejects an expired candidate", async (t) => {
  const state = await setup(t);
  const baseline = await state.writeEnvelope(
    "expired-old.json",
    state.payload("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
  );
  const candidate = await state.writeEnvelope(
    "expired-new.json",
    state.payload("2026-09-11T00:00:00Z", "2026-09-18T00:00:00Z"),
  );
  await assert.rejects(
    prepareCatalogSnapshot(state.options(candidate.file, baseline.file)),
    /index has expired/,
  );
});

test("rejects normalized id collisions and enforces the 1 MiB input boundary", async (t) => {
  const state = await setup(t);
  const second = structuredClone(state.packageValue);
  state.packageValue.agent.id = "a-b";
  second.agent.id = "ab";
  const collision = await state.writeEnvelope(
    "collision.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z", [state.packageValue, second]),
  );
  await assert.rejects(prepareCatalogSnapshot(state.options(collision.file)), /collides/);

  const valid = await state.writeEnvelope(
    "boundary.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z", [second]),
  );
  const bytes = await readFile(valid.file);
  await writeFile(
    valid.file,
    Buffer.concat([bytes, Buffer.alloc(1024 * 1024 - bytes.length, 0x20)]),
  );
  await prepareCatalogSnapshot(state.options(valid.file));
  await writeFile(valid.file, Buffer.concat([await readFile(valid.file), Buffer.from(" ")]));
  await assert.rejects(prepareCatalogSnapshot(state.options(valid.file)), /exceeds 1 MiB/);
});

test("historical baseline expiry exemption preserves other publication-window checks", async (t) => {
  const state = await setup(t);
  const candidate = await state.writeEnvelope(
    "candidate.json",
    state.payload("2026-09-19T11:00:00Z", "2026-09-20T00:00:00Z"),
  );
  for (const [generated, expires, pattern] of [
    ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", /exceeds 14 days/],
    ["2026-09-20T00:00:00Z", "2026-09-21T00:00:00Z", /future/],
    ["2026-09-10T00:00:00Z", "2026-09-09T00:00:00Z", /must follow/],
  ]) {
    const baseline = await state.writeEnvelope("baseline.json", state.payload(generated, expires));
    await assert.rejects(
      prepareCatalogSnapshot(state.options(candidate.file, baseline.file)),
      pattern,
    );
  }
});
