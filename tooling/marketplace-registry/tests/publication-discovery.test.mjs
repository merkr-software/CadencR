import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../scripts/lib.mjs";
import {
  buildPublicationBinding,
  buildPublicationReceipt,
  compactArtifacts,
} from "../scripts/publication/binding.mjs";
import { preparePublishedCatalog } from "../scripts/publication/catalog.mjs";
import { advanceCatalogDiscovery } from "../scripts/publication/discovery.mjs";
import { prepareCatalogSnapshot } from "../scripts/publication/snapshot.mjs";
import { signIndexPayload } from "../scripts/publication/signing.mjs";
import { stagePublication } from "../scripts/publication/stage.mjs";

const repository = "cadencr/registry";
const commit = "b".repeat(40);
const archive = Buffer.from("published archive");
const generatedAt = "2026-09-19T10:00:00Z";
const expiresAt = "2026-09-20T10:00:00Z";
const fresh = new Date("2026-09-19T10:00:01Z");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function submission() {
  const source = "https://github.com/acme/acme-agent";
  return {
    schema_version: 1,
    package: {
      agent: {
        id: "acme-agent",
        name: "Acme",
        version: "1.0.0",
        description: "Agent",
        license: "MIT",
        repository: source,
        distribution: {
          binary: {
            "linux-x86_64": {
              archive: `${source}/releases/download/v1/provider.tgz`,
              cmd: "bin/provider",
              sha256: hash(archive),
            },
          },
        },
      },
      host: {
        publisher: "acme",
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "icon.svg", readme: "README.md", license: "LICENSE" },
      },
    },
    source: { repository: source, commit: "a".repeat(40), tag: "v1" },
    changelog: "Release",
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "stage");
  const value = submission();
  const submissionFile = path.join(root, "submission.json");
  await writeFile(submissionFile, JSON.stringify(value));
  const staged = await stagePublication(value, repository, directory, {
    download: async ({ outputPath }) => writeFile(outputPath, archive, { flag: "wx" }),
  });
  const binding = buildPublicationBinding(staged, repository, commit, directory);
  await writeFile(
    path.join(directory, "mirror-receipt.json"),
    JSON.stringify({
      schema_version: 1,
      status: "draft_verified",
      repository,
      registry_commit: commit,
      release_id: 1,
      release_tag: binding.tag,
      plan_sha256: binding.planSha256,
      artifacts: compactArtifacts(binding.expected),
    }),
  );
  await writeFile(
    path.join(directory, "publication-receipt.json"),
    JSON.stringify(buildPublicationReceipt(binding, repository, commit, 1)),
  );
  const publicBytes = new Map(
    binding.expected.map((item) => [item.expectedUrl, item.bytes ?? archive]),
  );
  const sourceDownload = async ({ url, sha256, outputPath }) => {
    const bytes = publicBytes.get(url);
    assert(bytes);
    assert.equal(hash(bytes), sha256);
    await writeFile(outputPath, bytes, { flag: "wx" });
    return { size: bytes.length, sha256 };
  };
  const manifest = {
    schema_version: 1,
    repository,
    publications: [
      {
        submission: path.relative(root, submissionFile),
        directory: path.relative(root, directory),
        registry_commit: commit,
      },
    ],
  };
  const manifestFile = path.join(root, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest));
  const signed = await preparePublishedCatalog(manifest, {
    baseDirectory: root,
    generatedAt,
    expiresAt,
    download: sourceDownload,
    now: fresh,
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "private.pem");
  const publicKeyFile = path.join(root, "public.pem");
  await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(publicKeyFile, publicKey.export({ format: "pem", type: "spki" }));
  const envelope = await signIndexPayload(signed, {
    privateKeyFile,
    keyId: "release-2026",
    now: fresh,
  });
  const catalogFile = path.join(directory, "managed-index.json");
  await writeFile(catalogFile, `${canonicalJson(envelope)}\n`);
  const base = {
    directory,
    manifest: manifestFile,
    catalogFile,
    previousIndex: "bootstrap",
    publicKeyFile,
    keyId: "release-2026",
    repository,
    registryCommit: commit,
    now: new Date(fresh),
    download: sourceDownload,
  };
  const snapshot = await prepareCatalogSnapshot(base);
  publicBytes.set(snapshot.expectedUrl, snapshot.bytes);
  await writeCatalogReceipt(directory, snapshot);
  return { root, directory, base, snapshot, privateKeyFile, publicBytes, envelope };
}

async function writeCatalogReceipt(directory, snapshot) {
  await writeFile(
    path.join(directory, "catalog-publication-receipt.json"),
    JSON.stringify({
      schema_version: 1,
      status: "published_verified",
      repository,
      registry_commit: commit,
      release_id: 17,
      release_tag: snapshot.tag,
      tag_commit: commit,
      catalog_sha256: snapshot.sha256,
      catalog_size: snapshot.size,
      catalog_url: snapshot.expectedUrl,
      previous_sha256: snapshot.previousSha256 ?? "bootstrap",
    }),
  );
}
function discoveryClient(state, behavior = {}) {
  const calls = { get: 0, put: 0, find: 0, tag: 0 };
  let head = behavior.head ?? null;
  const release = {
    id: 17,
    draft: false,
    tag_name: state.snapshot.tag,
    target_commitish: commit,
    body: state.snapshot.body,
  };
  return {
    calls,
    async getDiscovery() {
      calls.get += 1;
      return head && { sha: head.sha, bytes: Buffer.from(head.bytes) };
    },
    async setDiscovery({ bytes }) {
      calls.put += 1;
      if (behavior.conflictWinner) {
        head = behavior.conflictWinner;
        throw new Error("CAS conflict");
      }
      head = { sha: "c".repeat(40), bytes: Buffer.from(bytes) };
      if (behavior.lostPut) throw new Error("lost PUT response");
    },
    async findRelease() {
      calls.find += 1;
      return release;
    },
    async getTagCommit() {
      calls.tag += 1;
      return commit;
    },
  };
}

const receiptPath = (state) => path.join(state.directory, "discovery-receipt.json");
const absent = (file) => assert.rejects(lstat(file), { code: "ENOENT" });

function discoveryDownload(state, action) {
  return async ({ outputPath, sha256 }) => {
    await action?.();
    await writeFile(outputPath, state.snapshot.bytes, { flag: "wx" });
    return { size: state.snapshot.size, sha256 };
  };
}

test("rejects a mismatched or newer discovery head without PUT", async (t) => {
  const state = await fixture(t);
  const client = discoveryClient(state, {
    head: { sha: "d".repeat(40), bytes: Buffer.from("newer signed-looking head") },
  });
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: discoveryDownload(state),
    }),
    /not absent for bootstrap/,
  );
  assert.equal(client.calls.put, 0);
  await absent(receiptPath(state));
});

test("a CAS conflict with another winner is never retried", async (t) => {
  const state = await fixture(t);
  const client = discoveryClient(state, {
    conflictWinner: { sha: "e".repeat(40), bytes: Buffer.from("other winner") },
  });
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: discoveryDownload(state),
    }),
    /CAS conflict/,
  );
  assert.equal(client.calls.put, 1);
  await absent(receiptPath(state));
});

test("raw failure leaves no receipt and replay recovers without another PUT", async (t) => {
  const state = await fixture(t);
  const client = discoveryClient(state, { lostPut: true });
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: async () => {
        throw new Error("raw unavailable");
      },
    }),
    /raw unavailable/,
  );
  await absent(receiptPath(state));
  await advanceCatalogDiscovery({
    ...state.base,
    client,
    discoveryBranch: "catalog",
    downloadDiscovery: discoveryDownload(state),
  });
  assert.equal(client.calls.put, 1);
  assert.equal(
    JSON.parse(await readFile(receiptPath(state), "utf8")).snapshot_sha256,
    state.snapshot.sha256,
  );
});

test("expiry during raw verification prevents a success receipt", async (t) => {
  const state = await fixture(t);
  const client = discoveryClient(state);
  const now = new Date(fresh);
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      now,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: discoveryDownload(state, () => now.setTime(Date.parse(expiresAt) + 1)),
    }),
    /index has expired/,
  );
  assert.equal(client.calls.put, 1);
  await absent(receiptPath(state));
});

test("a malformed existing discovery receipt fails before API calls or writes", async (t) => {
  const state = await fixture(t);
  await writeFile(receiptPath(state), "{broken");
  const client = discoveryClient(state);
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: discoveryDownload(state),
    }),
    /existing discovery receipt is invalid/,
  );
  assert.deepEqual(client.calls, { get: 0, put: 0, find: 0, tag: 0 });
});

test("a conflicting existing discovery receipt fails before API calls or writes", async (t) => {
  const state = await fixture(t);
  await writeFile(
    receiptPath(state),
    JSON.stringify({
      schema_version: 1,
      status: "discovery_verified",
      repository: "foreign/registry",
      branch: "catalog",
      url: "https://raw.githubusercontent.com/cadencr/registry/refs/heads/catalog/managed-index.json",
      snapshot_sha256: state.snapshot.sha256,
      baseline_sha256: "bootstrap",
      blob_sha: "f".repeat(40),
      release_id: 17,
      release_tag: state.snapshot.tag,
      registry_commit: commit,
      tag_commit: commit,
    }),
  );
  const client = discoveryClient(state);
  await assert.rejects(
    advanceCatalogDiscovery({
      ...state.base,
      client,
      discoveryBranch: "catalog",
      downloadDiscovery: discoveryDownload(state),
    }),
    /existing discovery receipt conflicts/,
  );
  assert.deepEqual(client.calls, { get: 0, put: 0, find: 0, tag: 0 });
});

test("a null discovery receipt is invalid before API calls", async (t) => {
  const state = await fixture(t);
  await writeFile(receiptPath(state), "null");
  const client = discoveryClient(state);
  await assert.rejects(
    advanceCatalogDiscovery({ ...state.base, client, discoveryBranch: "catalog" }),
    /existing discovery receipt is invalid/,
  );
  assert.deepEqual(client.calls, { get: 0, put: 0, find: 0, tag: 0 });
});

test("requires the D6 catalog receipt before any API call", async (t) => {
  const state = await fixture(t);
  await unlink(path.join(state.directory, "catalog-publication-receipt.json"));
  const client = discoveryClient(state);
  await assert.rejects(
    advanceCatalogDiscovery({ ...state.base, client, discoveryBranch: "catalog" }),
    /catalog publication receipt is required/,
  );
  assert.deepEqual(client.calls, { get: 0, put: 0, find: 0, tag: 0 });
});

test("rejects a symbolic catalog lock before snapshot or API work", async (t) => {
  const state = await fixture(t);
  await symlink(
    path.join(state.directory, "external-lock"),
    path.join(state.directory, ".catalog.lock"),
  );
  const client = discoveryClient(state);
  await assert.rejects(
    advanceCatalogDiscovery({ ...state.base, client, discoveryBranch: "catalog" }),
    /catalog lock must not be a symbolic link/,
  );
  assert.deepEqual(client.calls, { get: 0, put: 0, find: 0, tag: 0 });
});

test("advances from the exact canonical signed baseline", async (t) => {
  const state = await fixture(t);
  const baselinePayload = structuredClone(state.envelope.signed);
  baselinePayload.generated_at = "2026-09-19T09:59:00Z";
  const baselineEnvelope = await signIndexPayload(baselinePayload, {
    privateKeyFile: state.privateKeyFile,
    keyId: "release-2026",
    now: fresh,
  });
  const baselineBytes = Buffer.from(`${canonicalJson(baselineEnvelope)}\n`);
  const baselineFile = path.join(state.root, "baseline.json");
  await writeFile(baselineFile, baselineBytes);
  state.base.previousIndex = baselineFile;
  state.snapshot = await prepareCatalogSnapshot(state.base);
  state.publicBytes.set(state.snapshot.expectedUrl, state.snapshot.bytes);
  await writeCatalogReceipt(state.directory, state.snapshot);
  const client = discoveryClient(state, {
    head: { sha: "d".repeat(40), bytes: baselineBytes },
  });
  const receipt = await advanceCatalogDiscovery({
    ...state.base,
    client,
    discoveryBranch: "catalog",
    downloadDiscovery: discoveryDownload(state),
  });
  assert.equal(client.calls.put, 1);
  assert.equal(receipt.baseline_sha256, state.snapshot.previousSha256);
  assert.equal(receipt.snapshot_sha256, state.snapshot.sha256);
});
