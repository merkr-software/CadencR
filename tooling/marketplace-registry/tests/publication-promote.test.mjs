import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mirrorPublication } from "../scripts/publication/mirror.mjs";
import { promotePublication } from "../scripts/publication/promote.mjs";
import { stagePublication } from "../scripts/publication/stage.mjs";

const repository = "cadencr/registry";
const commit = "b".repeat(40);
const archive = Buffer.from("archive");
const digest = (value) => createHash("sha256").update(value).digest("hex");

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
              sha256: digest(archive),
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

function fakeClient() {
  const assets = [];
  const contents = new Map();
  const calls = { publish: 0, verify: 0, public: 0 };
  let release;
  let tagCommit = commit;
  return {
    assets,
    contents,
    calls,
    get release() {
      return release;
    },
    set release(value) {
      release = value;
    },
    set tagCommit(value) {
      tagCommit = value;
    },
    async findRelease() {
      return release;
    },
    async createDraft({ tag, commit: target, body }) {
      release = { id: 7, draft: true, tag_name: tag, target_commitish: target, body };
      return release;
    },
    async listAssets() {
      return assets.map((asset) => ({ ...asset }));
    },
    async uploadAsset({ name, file }) {
      const value = await readFile(file);
      const asset = {
        id: assets.length + 1,
        name,
        size: value.length,
        state: "uploaded",
        browser_download_url: `https://github.com/${repository}/releases/download/provider-acme-agent-v1.0.0/${name}`,
      };
      assets.push(asset);
      contents.set(name, value);
      return asset;
    },
    async verifyAsset({ asset, expectedUrl, sha256, size, outputPath }) {
      calls.verify += 1;
      assert.equal(asset.browser_download_url, expectedUrl);
      const value = contents.get(asset.name);
      assert.equal(value.length, size);
      assert.equal(digest(value), sha256);
      await writeFile(outputPath, value, { flag: "wx" });
      return { size, sha256 };
    },
    async getTagCommit() {
      return tagCommit;
    },
    async publishDraft() {
      calls.publish += 1;
      release = { ...release, draft: false };
      return release;
    },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publication-promote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await stagePublication(submission(), repository, directory, {
    download: async ({ outputPath }) => writeFile(outputPath, archive, { flag: "wx" }),
  });
  const client = fakeClient();
  await mirrorPublication({
    submission: submission(),
    repository,
    registryCommit: commit,
    directory,
    client,
  });
  const download = async ({ url, sha256, outputPath, maxBytes }) => {
    client.calls.public += 1;
    assert.match(url, /^https:\/\/github\.com\//);
    const name = new URL(url).pathname.split("/").at(-1);
    const value = client.contents.get(name);
    assert.ok(value.length <= maxBytes);
    assert.equal(digest(value), sha256);
    await writeFile(outputPath, value, { flag: "wx" });
    return { size: value.length, sha256 };
  };
  return { directory, client, download };
}

const promote = ({ directory, client, download }) =>
  promotePublication({
    submission: submission(),
    repository,
    registryCommit: commit,
    directory,
    client,
    download,
  });

test("publishes once, verifies public bytes, and safely replays", async (t) => {
  const state = await fixture(t);
  const first = await promote(state);
  assert.equal(first.status, "published_verified");
  assert.equal(state.client.calls.publish, 1);
  assert.equal(state.client.calls.public, 2);
  const before = await readFile(path.join(state.directory, "publication-receipt.json"));
  const second = await promote(state);
  assert.deepEqual(second, first);
  assert.equal(state.client.calls.publish, 1);
  assert.deepEqual(await readFile(path.join(state.directory, "publication-receipt.json")), before);
});

test("reconciles a lost PATCH response without blindly repeating it", async (t) => {
  const state = await fixture(t);
  state.client.publishDraft = async () => {
    state.client.calls.publish += 1;
    state.client.release = { ...state.client.release, draft: false };
    throw new Error("lost PATCH response");
  };
  await promote(state);
  assert.equal(state.client.calls.publish, 1);
});

test("a failed PATCH that remains draft is not repeated and leaves no owned files", async (t) => {
  const state = await fixture(t);
  state.client.publishDraft = async () => {
    state.client.calls.publish += 1;
    throw new Error("PATCH failed");
  };
  await assert.rejects(promote(state), /PATCH failed/);
  assert.equal(state.client.calls.publish, 1);
  const names = await readdir(state.directory);
  assert.equal(names.includes("publication-receipt.json"), false);
  assert.equal(
    names.some(
      (name) =>
        name.startsWith(".promote-") ||
        name.startsWith(".mirror-verify-") ||
        name.endsWith(".part"),
    ),
    false,
  );
});

test("rejects tag conflict and missing tag before PATCH", async (t) => {
  for (const value of ["a".repeat(40), null]) {
    const state = await fixture(t);
    state.client.tagCommit = value;
    await assert.rejects(promote(state), /tag commit does not match/);
    assert.equal(state.client.calls.publish, 0);
  }
});

test("public verification failure creates no publication receipt", async (t) => {
  const state = await fixture(t);
  state.download = async () => {
    throw new Error("public bytes unavailable");
  };
  await assert.rejects(promote(state), /public bytes unavailable/);
  await assert.rejects(readFile(path.join(state.directory, "publication-receipt.json")), {
    code: "ENOENT",
  });
  assert.equal(state.client.calls.publish, 1);
});

test("remote changes during public verification prevent the receipt", async (t) => {
  for (const mutate of [
    (state) => {
      state.client.tagCommit = "a".repeat(40);
    },
    (state) => {
      state.client.release = { ...state.client.release, body: "changed" };
    },
  ]) {
    const state = await fixture(t);
    const download = state.download;
    state.download = async (options) => {
      const result = await download(options);
      mutate(state);
      return result;
    };
    await assert.rejects(promote(state), /tag commit does not match|immutable binding/);
    await assert.rejects(readFile(path.join(state.directory, "publication-receipt.json")), {
      code: "ENOENT",
    });
  }
});

test("canonical-equivalent receipt replay cleans its owned temporary", async (t) => {
  const state = await fixture(t);
  const receipt = await promote(state);
  await writeFile(
    path.join(state.directory, "publication-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await promote(state);
  const names = await readdir(state.directory);
  assert.equal(
    names.some((name) => name.includes("publication-receipt.json.") && name.endsWith(".part")),
    false,
  );
});

test("foreign or conflicting receipts fail before remote access", async (t) => {
  for (const name of ["mirror-receipt.json", "publication-receipt.json"]) {
    const state = await fixture(t);
    await writeFile(path.join(state.directory, name), JSON.stringify({ foreign: true }));
    const before = state.client.calls.verify;
    await assert.rejects(promote(state), /receipt.*conflict/);
    assert.equal(state.client.calls.verify, before);
    assert.equal(state.client.calls.publish, 0);
  }
});

test("verification failures preserve unrelated temporary files", async (t) => {
  const state = await fixture(t);
  const sentinel = path.join(state.directory, ".foreign.part");
  await writeFile(sentinel, "keep");
  state.client.verifyAsset = async () => {
    throw new Error("fresh verification failed");
  };
  await assert.rejects(promote(state), /fresh verification failed/);
  assert.equal(await readFile(sentinel, "utf8"), "keep");
  assert.equal(state.client.calls.publish, 0);
});
