import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mirrorPublication } from "../scripts/publication/mirror.mjs";
import { stagePublication } from "../scripts/publication/stage.mjs";

const repository = "cadencr/registry";
const commit = "b".repeat(40);
const bytes = Buffer.from("archive");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cli = fileURLToPath(new URL("../scripts/mirror-publication.mjs", import.meta.url));

function submission() {
  const source = "https://github.com/acme/provider";
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
              sha256: hash(bytes),
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

async function directory(t, staged = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (staged) {
    await stagePublication(submission(), repository, root, {
      download: async ({ outputPath }) => writeFile(outputPath, bytes, { flag: "wx" }),
    });
  }
  return root;
}

const mirror = (directory, client) =>
  mirrorPublication({
    submission: submission(),
    repository,
    registryCommit: commit,
    directory,
    client,
  });

function fakeClient({ existingRelease, createFailure, uploadFailure, assetMutation } = {}) {
  const assets = [];
  const contents = new Map();
  const calls = { find: 0, create: 0, upload: 0, verify: 0 };
  let release = existingRelease ?? null;
  const client = {
    calls,
    assets,
    get release() {
      return release;
    },
    set release(value) {
      release = value;
    },
    async findRelease() {
      calls.find += 1;
      return release;
    },
    async createDraft({ tag, commit: target, body }) {
      calls.create += 1;
      release = {
        id: 7,
        draft: true,
        tag_name: tag,
        target_commitish: target,
        body,
      };
      if (createFailure) throw new Error("lost create response");
      return release;
    },
    async listAssets() {
      return assets.map((asset) => ({ ...asset }));
    },
    async uploadAsset({ name, file }) {
      calls.upload += 1;
      const value = await readFile(file);
      const asset = {
        id: assets.length + 1,
        name,
        size: value.length,
        state: "uploaded",
        browser_download_url: `https://github.com/${repository}/releases/download/provider-acme-agent-v1.0.0/${name}`,
      };
      assets.push(assetMutation ? assetMutation(asset) : asset);
      contents.set(name, value);
      if (uploadFailure) throw new Error("lost upload response");
      return asset;
    },
    async verifyAsset({ asset, expectedUrl, sha256, size, outputPath }) {
      calls.verify += 1;
      assert.equal(asset.browser_download_url, expectedUrl);
      const value = contents.get(asset.name);
      assert.equal(value.length, size);
      assert.equal(hash(value), sha256);
      await writeFile(outputPath, value, { flag: "wx" });
    },
  };
  return client;
}

test("creates and verifies a draft, then retries without another POST", async (t) => {
  const root = await directory(t);
  const client = fakeClient();
  const first = await mirror(root, client);
  assert.equal(first.status, "draft_verified");
  assert.equal(first.artifacts.length, 2);
  assert.equal(client.calls.create, 1);
  const second = await mirror(root, client);
  assert.deepEqual(second, first);
  assert.equal(client.calls.create, 1);
});

test("recovers lost create and upload responses", async (t) => {
  const root = await directory(t);
  const client = fakeClient({ createFailure: true, uploadFailure: true });
  const receipt = await mirror(root, client);
  assert.equal(receipt.artifacts.length, 2);
  assert.equal(client.calls.create, 1);
  assert.equal(client.calls.upload, 2);
});

test("refuses published, conflicting, unexpected, starter, and corrupt remote state", async (t) => {
  const root = await directory(t);
  const base = {
    id: 7,
    draft: false,
    tag_name: "provider-acme-agent-v1.0.0",
    target_commitish: commit,
    body: "wrong",
  };
  const published = fakeClient({ existingRelease: base });
  await assert.rejects(mirror(root, published), /non-draft|published/);
  assert.equal(published.calls.upload, 0);
  const conflicting = fakeClient({ existingRelease: { ...base, draft: true } });
  await assert.rejects(mirror(root, conflicting), /immutable binding/);
  assert.equal(conflicting.calls.upload, 0);

  for (const mutation of [
    (asset) => ({ ...asset, name: "unexpected" }),
    (asset) => ({ ...asset, state: "starter" }),
  ]) {
    const client = fakeClient({ assetMutation: mutation });
    await assert.rejects(mirror(root, client), /unexpected|not uploaded/);
  }
  const corrupt = fakeClient();
  const verifier = corrupt.verifyAsset;
  corrupt.verifyAsset = async (options) => {
    if (options.asset.name !== "publication-plan.json") throw new Error("remote bytes mismatch");
    return verifier(options);
  };
  await assert.rejects(mirror(root, corrupt), /remote bytes mismatch/);
});

test("missing local staging fails before remote calls and leaves a foreign lock", async (t) => {
  const root = await directory(t, false);
  const client = fakeClient();
  await assert.rejects(mirror(root, client), /not fully staged/);
  assert.equal(client.calls.find, 0);
  await writeFile(path.join(root, ".mirror.lock"), "foreign");
  await assert.rejects(mirror(root, client), /already locked/);
  assert.equal(await readFile(path.join(root, ".mirror.lock"), "utf8"), "foreign");
});

test("rejects a symlink directory before writes or remote calls", async (t) => {
  const root = await directory(t);
  const link = `${root}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(root, link);
  const client = fakeClient();
  const before = await lstat(root);
  await assert.rejects(mirror(link, client), /non-symlink/);
  assert.equal(client.calls.find, 0);
  assert.equal((await lstat(root)).mtimeMs, before.mtimeMs);
});

test("strictly refuses truthy non-boolean draft state", async (t) => {
  const root = await directory(t);
  const client = fakeClient();
  const options = {
    submission: submission(),
    repository,
    registryCommit: commit,
    directory: root,
    client,
  };
  await mirrorPublication(options);
  client.release = { ...client.release, draft: "false" };
  await assert.rejects(mirrorPublication(options), /non-draft|published/);
});

test("invalid or mismatched receipt stops before remote access", async (t) => {
  for (const value of ["{", JSON.stringify({ schema_version: 1, status: "wrong" })]) {
    const root = await directory(t);
    await writeFile(path.join(root, "mirror-receipt.json"), value);
    const client = fakeClient();
    await assert.rejects(mirror(root, client), /receipt is invalid|receipt conflicts/);
    assert.equal(client.calls.find, 0);
    assert.equal(client.calls.create, 0);
  }
});

test("a prior receipt refuses missing or replaced remote releases without POST", async (t) => {
  const root = await directory(t);
  const original = fakeClient();
  await mirror(root, original);
  const missing = fakeClient();
  await assert.rejects(mirror(root, missing), /missing release/);
  assert.equal(missing.calls.create, 0);
  const replaced = fakeClient({ existingRelease: { ...original.release, id: 99 } });
  await assert.rejects(mirror(root, replaced), /release id conflicts/);
  assert.equal(replaced.calls.create, 0);
});

test("promotion between release checks aborts before upload", async (t) => {
  const root = await directory(t);
  const client = fakeClient();
  const find = client.findRelease;
  client.findRelease = async (...args) => {
    const release = await find(...args);
    if (client.calls.find >= 2) return { ...release, draft: false };
    return release;
  };
  await assert.rejects(mirror(root, client), /non-draft|published/);
  assert.equal(client.calls.upload, 0);
});

test("verification failure preserves arbitrary foreign partials", async (t) => {
  const root = await directory(t);
  const sentinel = path.join(root, ".foreign.part");
  await writeFile(sentinel, "keep");
  const client = fakeClient();
  client.verifyAsset = async () => {
    throw new Error("verification failed");
  };
  await assert.rejects(mirror(root, client), /verification failed/);
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test("unexpected remote fields never reflect secrets", async (t) => {
  const secret = "TOP_SECRET_REMOTE_VALUE";
  for (const mutation of [
    (asset) => ({ ...asset, name: secret }),
    (asset) => ({ ...asset, state: secret }),
  ]) {
    const root = await directory(t);
    const client = fakeClient({ assetMutation: mutation });
    await assert.rejects(mirror(root, client), (error) => !error.message.includes(secret));
  }
});

test("CLI requires exact confirmation before requiring its dedicated token", async (t) => {
  const root = await directory(t);
  const input = path.join(root, "submission.json");
  await writeFile(input, JSON.stringify(submission()));
  const args = [
    cli,
    "--submission",
    input,
    "--repository",
    repository,
    "--registry-commit",
    commit,
    "--directory",
    root,
    "--confirm-repository",
  ];
  const env = { ...process.env };
  delete env.CADENCR_REGISTRY_GITHUB_TOKEN;
  const mismatch = spawnSync(process.execPath, [...args, "other/repo"], { encoding: "utf8", env });
  assert.match(mismatch.stderr, /confirmation/);
  assert.doesNotMatch(mismatch.stderr, /TOKEN/);
  const confirmed = spawnSync(process.execPath, [...args, repository], { encoding: "utf8", env });
  assert.match(confirmed.stderr, /CADENCR_REGISTRY_GITHUB_TOKEN is required/);
});
