import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { publishCatalogSnapshot } from "../scripts/publication/publish-catalog.mjs";
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
  return { root, directory, base, snapshot };
}

function fakeClient(state, behavior = {}) {
  const calls = { find: 0, create: 0, list: 0, upload: 0, verify: 0, patch: 0, tag: 0 };
  let release = behavior.release ?? null;
  const assets = [...(behavior.assets ?? [])];
  const releaseValue = (draft, id = 17) => ({
    id,
    draft,
    tag_name: state.snapshot.tag,
    target_commitish: commit,
    body: state.snapshot.body,
  });
  const client = {
    calls,
    assets,
    async findRelease() {
      calls.find += 1;
      return release && { ...release };
    },
    async createDraft() {
      calls.create += 1;
      release = releaseValue(true);
      if (behavior.lostCreate) throw new Error("lost create response");
      return { ...release };
    },
    async listAssets() {
      calls.list += 1;
      return assets.map((asset) => ({ ...asset }));
    },
    async uploadAsset({ name, file }) {
      calls.upload += 1;
      const bytes = await readFile(file);
      assets.push({
        id: 9,
        name,
        size: bytes.length,
        state: "uploaded",
        browser_download_url: state.snapshot.expectedUrl,
      });
      if (behavior.lostUpload) throw new Error("lost upload response");
    },
    async verifyAsset({ asset, expectedUrl, sha256, size, outputPath }) {
      calls.verify += 1;
      assert.equal(asset.browser_download_url, expectedUrl);
      assert.equal(size, state.snapshot.size);
      assert.equal(sha256, state.snapshot.sha256);
      await writeFile(outputPath, state.snapshot.bytes, { flag: "wx" });
      return { size, sha256 };
    },
    async getTagCommit() {
      calls.tag += 1;
      return commit;
    },
    async publishDraft() {
      calls.patch += 1;
      if (behavior.patchId) return releaseValue(false, behavior.patchId);
      if (!behavior.patchFailure) release = releaseValue(false);
      if (behavior.patchFailure) throw new Error("PATCH failed");
      return { ...release };
    },
  };
  if (behavior.recoverPatch) {
    client.publishDraft = async () => {
      calls.patch += 1;
      release = releaseValue(false);
      throw new Error("lost PATCH response");
    };
  }
  return client;
}

const receiptFile = (state) => path.join(state.directory, "catalog-publication-receipt.json");
const publish = (state, client, overrides = {}) =>
  publishCatalogSnapshot({ ...state.base, client, ...overrides });
const missing = (file) => assert.rejects(lstat(file), { code: "ENOENT" });

test("reconciles lost create, upload, and PATCH responses without repeating mutations", async (t) => {
  for (const kind of ["lostCreate", "lostUpload", "recoverPatch"]) {
    await t.test(kind, async (t) => {
      const state = await fixture(t);
      const client = fakeClient(state, { [kind]: true });
      await publish(state, client);
      assert.equal(client.calls.create, 1);
      assert.equal(client.calls.upload, 1);
      assert.equal(client.calls.patch, 1);
      assert.equal(JSON.parse(await readFile(receiptFile(state), "utf8")).release_id, 17);
    });
  }
});

test("leaves no receipt when PATCH fails and the release remains draft", async (t) => {
  const state = await fixture(t);
  const client = fakeClient(state, { patchFailure: true });
  await assert.rejects(publish(state, client), /PATCH failed/);
  assert.equal(client.calls.patch, 1);
  await missing(receiptFile(state));
});

test("rejects a malformed receipt before making any API call", async (t) => {
  const state = await fixture(t);
  await writeFile(receiptFile(state), "{broken");
  const client = fakeClient(state);
  await assert.rejects(publish(state, client), /existing catalog receipt is invalid/);
  assert.deepEqual(client.calls, {
    find: 0,
    create: 0,
    list: 0,
    upload: 0,
    verify: 0,
    patch: 0,
    tag: 0,
  });
});

test("a published release missing its asset fails without attempting upload", async (t) => {
  const state = await fixture(t);
  const client = fakeClient(state, {
    release: {
      id: 17,
      draft: false,
      tag_name: state.snapshot.tag,
      target_commitish: commit,
      body: state.snapshot.body,
    },
  });
  await assert.rejects(publish(state, client), /published catalog release is missing/);
  assert.equal(client.calls.upload, 0);
  await missing(receiptFile(state));
});

test("preserves an operator-owned .catalog-sha.part file", async (t) => {
  const state = await fixture(t);
  const part = path.join(state.directory, `.catalog-${state.snapshot.sha256}.part`);
  await writeFile(part, "operator-owned");
  const client = fakeClient(state);
  await publish(state, client);
  assert.equal(await readFile(part, "utf8"), "operator-owned");
});

test("rejects a direct symlink directory without locking its external target", async (t) => {
  const state = await fixture(t);
  const target = path.join(state.root, "external");
  const link = path.join(state.root, "linked-stage");
  await symlink(state.directory, link, "dir");
  const client = fakeClient(state);
  await assert.rejects(publish(state, client, { directory: link }), /non-symlink directory/);
  await missing(path.join(target, ".catalog.lock"));
  await missing(path.join(state.directory, ".catalog.lock"));
  assert.equal(client.calls.find, 0);
});

test("rejects a successful PATCH response carrying the wrong release id", async (t) => {
  const state = await fixture(t);
  const client = fakeClient(state, { patchId: 999 });
  await assert.rejects(publish(state, client), /release id conflicts/);
  assert.equal(client.calls.patch, 1);
  await missing(receiptFile(state));
});

test("expiry during final verification prevents the receipt", async (t) => {
  const state = await fixture(t);
  const client = fakeClient(state);
  const now = new Date(fresh);
  const download = async (request) => {
    if (request.url !== state.snapshot.expectedUrl) return state.base.download(request);
    now.setTime(Date.parse(expiresAt) + 1000);
    await writeFile(request.outputPath, state.snapshot.bytes, { flag: "wx" });
    return { size: state.snapshot.size, sha256: request.sha256 };
  };
  await assert.rejects(publish(state, client, { now, download }), /index has expired/);
  assert.equal(client.calls.patch, 1);
  await missing(receiptFile(state));
});

test("tag conflicts fail closed before writes, before PATCH, and before the final receipt", async (t) => {
  for (const checkpoint of [1, 2, 4]) {
    const state = await fixture(t);
    const client = fakeClient(state);
    client.getTagCommit = async () => {
      client.calls.tag += 1;
      return client.calls.tag === checkpoint ? "f".repeat(40) : commit;
    };
    await assert.rejects(publish(state, client), /tag commit does not match/);
    assert.equal(client.calls.create, checkpoint === 1 ? 0 : 1);
    assert.equal(client.calls.patch, checkpoint < 3 ? 0 : 1);
    await missing(receiptFile(state));
  }
});
