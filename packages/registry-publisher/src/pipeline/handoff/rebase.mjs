// Test-only timestamp adaptation, never a publisher. No publication orchestration imports.
import { createHash, sign, verify } from "node:crypto";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { dirname, join, sep } from "node:path";
import assert from "node:assert/strict";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const encoded = (value) => Buffer.from(canonical(value) + "\n");
const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function assertOnlyFields(before, after, fields) {
  const left = structuredClone(before),
    right = structuredClone(after);
  for (const path of fields) {
    for (const value of [left, right]) {
      const parts = path.split(".");
      const parent = parts.slice(0, -1).reduce((object, key) => object?.[key], value);
      if (parent) delete parent[parts.at(-1)];
    }
  }
  assert.deepEqual(right, left, "timestamp adaptation modified an unapproved field");
}
export async function loadCapture(input) {
  const directory = await realpath(input.directory);
  assert(
    directory.startsWith((await realpath(tmpdir())) + sep),
    "test-owned temporary directory only",
  );
  const compressed = await readFile(input.capture);
  assert.equal(hash(compressed), input.hashes.sha256, "exact compressed capture hash");
  const original = gunzipSync(compressed, { maxOutputLength: 512 * 1024 });
  assert.equal(hash(original), input.hashes.uncompressed_sha256, "exact archived raw capture hash");
  const capture = JSON.parse(original);
  const disk = Object.fromEntries(
    Object.entries(capture.disk).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]),
  );
  const inputs = Object.fromEntries(
    Object.entries(capture.inputs).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]),
  );
  const request = JSON.parse(inputs["request.json"]);
  const now = Math.floor(Date.now() / 1000) * 1000;
  request.generated_at = new Date(now - 60000).toISOString().replace(".000Z", "Z");
  request.expires_at = new Date(now + 86400000).toISOString().replace(".000Z", "Z");
  inputs["request.json"] = Buffer.from(JSON.stringify(request));
  const binding = JSON.parse(disk["pipeline-request.json"]);
  binding.request = request;
  binding.request_sha256 = hash(inputs["request.json"]);
  disk["pipeline-request.json"] = encoded(binding);
  const remote = structuredClone(capture.remote);
  if (disk["managed-index.json"]) rebaseCatalog(disk, inputs, request, remote);
  assertAdaptation(capture, disk, inputs, request, remote);
  // All other files remain byte-for-byte archived, including plans/archives/submissions.
  for (const [name, bytes] of Object.entries({
    ...inputs,
    ...Object.fromEntries(Object.entries(disk).map(([name, bytes]) => [`state/${name}`, bytes])),
  })) {
    const path = join(input.directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return { remote, result: capture.result };
}

function rebaseCatalog(disk, inputs, request, remote) {
  const oldBytes = disk["managed-index.json"],
    oldHash = hash(oldBytes);
  const envelope = JSON.parse(oldBytes);
  assert(
    verify(
      null,
      Buffer.from(canonical(envelope.signed)),
      inputs["public.pem"],
      Buffer.from(envelope.signature.value, "base64"),
    ),
    "archived signature",
  );
  envelope.signed.generated_at = request.generated_at;
  envelope.signed.expires_at = request.expires_at;
  envelope.signature.value = sign(
    null,
    Buffer.from(canonical(envelope.signed)),
    inputs["private.pem"],
  ).toString("base64");
  const bytes = encoded(envelope),
    digest = hash(bytes);
  const oldTag = `catalog-${oldHash}`,
    tag = `catalog-${digest}`;
  const url = `https://github.com/cadencr/registry/releases/download/${tag}/managed-index.json`;
  disk["managed-index.json"] = bytes;
  const receipt = JSON.parse(disk["catalog-publication-receipt.json"]);
  Object.assign(receipt, {
    catalog_sha256: digest,
    catalog_size: bytes.length,
    catalog_url: url,
    release_tag: tag,
  });
  disk["catalog-publication-receipt.json"] = encoded(receipt);
  if (disk["discovery-receipt.json"]) {
    const discovery = JSON.parse(disk["discovery-receipt.json"]);
    Object.assign(discovery, {
      blob_sha: blob(bytes),
      release_tag: tag,
      snapshot_sha256: digest,
    });
    disk["discovery-receipt.json"] = encoded(discovery);
  }
  const release = remote.releases.find((r) => r.tag_name === oldTag);
  assert(release, "captured catalog release");
  Object.assign(release, {
    tag_name: tag,
    name: tag,
    body: release.body.replace(`catalog-sha256:${oldHash}`, `catalog-sha256:${digest}`),
  });
  const asset = remote.assets.find(
    (a) => a.release_id === release.id && a.name === "managed-index.json",
  );
  Object.assign(asset, { bytes, size: bytes.length, browser_download_url: url });
  const ref = remote.tags.find(([name]) => name === oldTag);
  assert(ref);
  ref[0] = tag;
  if (remote.discovery) Object.assign(remote.discovery, { bytes, sha: blob(bytes) });
}

function assertAdaptation(capture, disk, inputs, request, remote) {
  assertOnlyFields(JSON.parse(Buffer.from(capture.inputs["request.json"], "base64")), request, [
    "generated_at",
    "expires_at",
  ]);
  const diskFields = {
    "pipeline-request.json": ["request.generated_at", "request.expires_at", "request_sha256"],
    "managed-index.json": ["signed.generated_at", "signed.expires_at", "signature.value"],
    "catalog-publication-receipt.json": [
      "catalog_sha256",
      "catalog_size",
      "catalog_url",
      "release_tag",
    ],
    "discovery-receipt.json": ["blob_sha", "release_tag", "snapshot_sha256"],
  };
  for (const [name, bytes] of Object.entries(disk)) {
    const before = Buffer.from(capture.disk[name], "base64");
    if (diskFields[name]) assertOnlyFields(JSON.parse(before), JSON.parse(bytes), diskFields[name]);
    else assert.deepEqual(bytes, before, `unmodified archived file ${name}`);
  }
  for (const [name, bytes] of Object.entries(inputs)) {
    if (name !== "request.json")
      assert.deepEqual(bytes, Buffer.from(capture.inputs[name], "base64"));
  }
  // Exact indices belong to this single-provider capture, not arbitrary fixtures.
  // JSON roundtrip normalizes in-memory Buffers to their archived wire representation.
  assertOnlyFields(capture.remote, JSON.parse(JSON.stringify(remote)), [
    "releases.1.tag_name",
    "releases.1.name",
    "releases.1.body",
    "assets.2.bytes",
    "assets.2.size",
    "assets.2.browser_download_url",
    "tags.1.0",
    "discovery.bytes",
    "discovery.sha",
  ]);
}
