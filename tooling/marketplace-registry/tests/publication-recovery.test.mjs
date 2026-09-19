import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPublicationBinding } from "../scripts/publication/binding.mjs";
import { recoverPublishedMirror } from "../scripts/publication/recover-publication.mjs";
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

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publication-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staged = await stagePublication(submission(), repository, directory, {
    download: async ({ outputPath }) => writeFile(outputPath, archive, { flag: "wx" }),
  });
  const binding = buildPublicationBinding(staged, repository, commit, directory);
  const contents = new Map();
  for (const item of binding.expected) {
    contents.set(item.name, item.bytes ?? (await readFile(item.file)));
  }
  const assets = binding.expected.map((item, index) => ({
    id: index + 1,
    name: item.name,
    state: "uploaded",
    size: item.size,
    browser_download_url: item.expectedUrl,
  }));
  let release = {
    id: 7,
    draft: false,
    tag_name: binding.tag,
    target_commitish: commit,
    body: binding.body,
  };
  let tagCommit = commit;
  const calls = { verify: 0, public: 0 };
  const client = {
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
    async listAssets() {
      return assets.map((asset) => ({ ...asset }));
    },
    async verifyAsset({ asset, expectedUrl, sha256, size, outputPath }) {
      calls.verify += 1;
      assert.equal(asset.browser_download_url, expectedUrl);
      const bytes = contents.get(asset.name);
      assert.equal(bytes.length, size);
      assert.equal(digest(bytes), sha256);
      await writeFile(outputPath, bytes, { flag: "wx" });
    },
    async getTagCommit() {
      return tagCommit;
    },
  };
  const download = async ({ url, sha256, outputPath, maxBytes }) => {
    calls.public += 1;
    assert.match(url, /^https:\/\/github\.com\//);
    const bytes = contents.get(new URL(url).pathname.split("/").at(-1));
    assert.ok(bytes.length <= maxBytes);
    assert.equal(digest(bytes), sha256);
    await writeFile(outputPath, bytes, { flag: "wx" });
    return { size: bytes.length, sha256 };
  };
  return { directory, binding, client, download, assets, contents, calls };
}

const recover = (state) =>
  recoverPublishedMirror({
    submission: submission(),
    repository,
    registryCommit: commit,
    directory: state.directory,
    client: state.client,
    download: state.download,
  });

async function absentReceipt(directory) {
  await assert.rejects(readFile(path.join(directory, "mirror-receipt.json")), { code: "ENOENT" });
}

test("recovers an exactly verified published release and safely replays", async (t) => {
  const state = await fixture(t);
  const first = await recover(state);
  assert.equal(first.status, "published_recovered");
  assert.equal(state.calls.verify, 4);
  assert.equal(state.calls.public, 2);
  assert.deepEqual(await recover(state), first);
  assert.equal(state.calls.verify, 8);
  assert.equal(state.calls.public, 4);
});

test("returns null for missing or draft releases without receipts", async (t) => {
  for (const release of [null, { id: 7, draft: true }]) {
    const state = await fixture(t);
    state.client.release = release;
    assert.equal(await recover(state), null);
    await absentReceipt(state.directory);
  }
});

test("requirePublished rejects missing or draft releases", async (t) => {
  for (const release of [null, { id: 7, draft: true }]) {
    const state = await fixture(t);
    state.client.release = release;
    await assert.rejects(
      recoverPublishedMirror({
        submission: submission(),
        repository,
        registryCommit: commit,
        directory: state.directory,
        client: state.client,
        download: state.download,
        requirePublished: true,
      }),
      /published release is required/,
    );
    await absentReceipt(state.directory);
  }
});

test("corrupt, incomplete, or unexpected remote assets leave no receipt", async (t) => {
  for (const mutate of [
    (state) => state.assets.pop(),
    (state) => state.assets.push({ name: "foreign", state: "uploaded" }),
    (state) =>
      (state.client.verifyAsset = async () => {
        throw new Error("corrupt remote bytes");
      }),
  ]) {
    const state = await fixture(t);
    mutate(state);
    await assert.rejects(recover(state), /missing expected|unexpected|corrupt remote/);
    await absentReceipt(state.directory);
  }
});

test("public archive or provenance failures leave no receipt", async (t) => {
  const names = (await fixture(t)).binding.expected.map(({ name }) => name);
  for (const failedName of names) {
    const state = await fixture(t);
    const good = state.download;
    state.download = async (options) => {
      if (options.url.endsWith(`/${failedName}`)) throw new Error("public provenance unavailable");
      return good(options);
    };
    await assert.rejects(recover(state), /public provenance unavailable/);
    await absentReceipt(state.directory);
  }
});

test("mismatched tags before or after public checks leave no receipt", async (t) => {
  const before = await fixture(t);
  before.client.tagCommit = "a".repeat(40);
  await assert.rejects(recover(before), /tag commit does not match/);
  await absentReceipt(before.directory);
  const after = await fixture(t);
  const good = after.download;
  after.download = async (options) => {
    const result = await good(options);
    after.client.tagCommit = "a".repeat(40);
    return result;
  };
  await assert.rejects(recover(after), /tag commit does not match/);
  await absentReceipt(after.directory);
});

test("a release changed during public verification leaves no receipt", async (t) => {
  const state = await fixture(t);
  const good = state.download;
  state.download = async (options) => {
    const result = await good(options);
    state.client.release = { ...state.client.release, body: "changed" };
    return result;
  };
  await assert.rejects(recover(state), /immutable binding/);
  await absentReceipt(state.directory);
});

test("asset deletion or same-name reupload during public checks leaves no receipt", async (t) => {
  for (const mutate of [
    (state) => state.assets.pop(),
    (state) => {
      state.assets[0] = { ...state.assets[0], id: 999 };
    },
  ]) {
    const state = await fixture(t);
    const good = state.download;
    let mutated = false;
    state.download = async (options) => {
      const result = await good(options);
      if (!mutated) {
        mutate(state);
        mutated = true;
      }
      return result;
    };
    await assert.rejects(recover(state), /missing expected assets|assets changed/);
    await absentReceipt(state.directory);
  }
});

test("malformed or conflicting existing receipts fail without overwrite", async (t) => {
  for (const name of ["mirror-receipt.json", "publication-receipt.json"]) {
    const state = await fixture(t);
    const file = path.join(state.directory, name);
    await writeFile(file, JSON.stringify({ foreign: true }));
    await assert.rejects(recover(state), /receipt.*conflict/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { foreign: true });
    if (name !== "mirror-receipt.json") await absentReceipt(state.directory);
  }
});

test("rejects symlink directories and cleans only owned temporary state", async (t) => {
  const state = await fixture(t);
  const link = `${state.directory}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(state.directory, link);
  await assert.rejects(
    recoverPublishedMirror({
      submission: submission(),
      repository,
      registryCommit: commit,
      directory: link,
      client: state.client,
      download: state.download,
    }),
    /non-symlink/,
  );
  state.download = async () => {
    throw new Error("failed public check");
  };
  await assert.rejects(recover(state), /failed public check/);
  const names = await readdir(state.directory);
  assert.equal(
    names.some(
      (name) =>
        name.startsWith(".promote-public-") ||
        name.startsWith(".mirror-verify-") ||
        name === ".mirror.lock",
    ),
    false,
  );
});
