import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoveryUrl,
  validateDiscoveryBranch,
} from "../scripts/publication/discovery-location.mjs";
import {
  downloadVerifiedArchive,
  downloadVerifiedDiscovery,
} from "../scripts/publication/download.mjs";
import { createGitHubClient } from "../scripts/publication/github.mjs";

const repository = "owner/repository";
const token = "secret";
const branch = "managed_v1";
const commitSha = "a".repeat(40);
const treeSha = "c".repeat(40);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function blob(bytes, patch = {}) {
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return {
    type: "file",
    path: "managed-index.json",
    name: "managed-index.json",
    encoding: "base64",
    size: bytes.length,
    sha,
    content: bytes.toString("base64").replace(/.{4}/g, "$&\n"),
    ...patch,
  };
}

function discoveryResponses(bytes, contentPatch = {}, treePatch = {}) {
  const content = blob(bytes, contentPatch);
  return [
    { ref: `refs/heads/${branch}`, object: { type: "commit", sha: commitSha } },
    { sha: commitSha, tree: { sha: treeSha } },
    {
      sha: treeSha,
      truncated: false,
      tree: [
        {
          path: "managed-index.json",
          mode: "100644",
          type: "blob",
          sha: content.sha,
          size: content.size,
          ...treePatch,
        },
      ],
    },
    content,
  ];
}

test("discovery location is fixed and branches are strict", () => {
  assert.equal(
    discoveryUrl(repository, branch),
    "https://raw.githubusercontent.com/owner/repository/refs/heads/managed_v1/managed-index.json",
  );
  for (const value of ["", "-bad", "a/b", "a.b", "a".repeat(65)]) {
    assert.throws(() => validateDiscoveryBranch(value), /branch/);
  }
});

test("getDiscovery verifies the branch, metadata, canonical base64, and Git blob hash", async () => {
  const bytes = Buffer.from("managed index");
  const calls = [];
  const responses = discoveryResponses(bytes);
  const client = createGitHubClient({
    repository,
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json(responses[calls.length - 1]);
    },
  });
  const result = await client.getDiscovery(branch);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.sha, blob(bytes).sha);
  assert.match(calls[1].url, new RegExp(`/git/commits/${commitSha}$`));
  assert.match(calls[2].url, new RegExp(`/git/trees/${treeSha}$`));
  assert.match(calls[3].url, new RegExp(`managed-index\\.json\\?ref=${commitSha}$`));
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);

  for (const patch of [
    { type: "symlink" },
    { path: "other" },
    { size: bytes.length + 1 },
    { content: "Zh==" },
    { sha: "0".repeat(40) },
    { size: 1024 * 1024 + 1 },
  ]) {
    const badResponses = discoveryResponses(bytes, patch);
    let count = 0;
    const bad = createGitHubClient({
      repository,
      token,
      fetchImpl: async () => json(badResponses[count++]),
    });
    await assert.rejects(bad.getDiscovery(branch), /malformed|hash/);
  }
});

test("only a missing top-level tree entry means absent", async () => {
  const absentResponses = discoveryResponses(Buffer.from("x"));
  absentResponses[2].tree = [];
  let call = 0;
  const absent = createGitHubClient({
    repository,
    token,
    fetchImpl: async () => json(absentResponses[call++]),
  });
  assert.equal(await absent.getDiscovery(branch), null);
  assert.equal(call, 3);

  for (const [failureAt, status] of [
    [0, 404],
    [1, 404],
    [2, 403],
    [3, 404],
  ]) {
    const responses = discoveryResponses(Buffer.from("x"));
    let index = 0;
    const client = createGitHubClient({
      repository,
      token,
      fetchImpl: async () => {
        const current = index++;
        return current === failureAt ? json({}, status) : json(responses[current]);
      },
    });
    await assert.rejects(client.getDiscovery(branch), new RegExp(`status ${status}`));
  }
});

test("tree proof rejects dereferenced symlinks and malformed or mismatched trees", async () => {
  const bytes = Buffer.from("real target bytes");
  for (const [treePatch, responsePatch = {}] of [
    [{ mode: "120000", type: "blob" }],
    [{ mode: "160000", type: "commit" }],
    [{ mode: "040000", type: "tree" }],
    [{ sha: "d".repeat(40) }],
    [{ size: 1024 * 1024 + 1 }],
    [{}, { truncated: true }],
    [{}, { sha: "e".repeat(40) }],
  ]) {
    const responses = discoveryResponses(bytes, {}, treePatch);
    Object.assign(responses[2], responsePatch);
    let call = 0;
    const client = createGitHubClient({
      repository,
      token,
      fetchImpl: async () => json(responses[call++]),
    });
    await assert.rejects(client.getDiscovery(branch), /tree|malformed/);
  }
});

test("setDiscovery uses one fixed CAS PUT and never adds sha for creation", async () => {
  const calls = [];
  const client = createGitHubClient({
    repository,
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json({ content: {} });
    },
  });
  await client.setDiscovery({ branch, bytes: Buffer.from("x"), expectedSha: null });
  await client.setDiscovery({ branch, bytes: Buffer.from("y"), expectedSha: "b".repeat(40) });
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      ({ url, options }) =>
        url.endsWith("/contents/managed-index.json") && options.method === "PUT",
    ),
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    branch,
    message: "Update managed provider discovery index",
    content: "eA==",
  });
  assert.equal(JSON.parse(calls[1].options.body).sha, "b".repeat(40));
  await assert.rejects(
    client.setDiscovery({ branch, bytes: Buffer.from("x"), expectedSha: "B".repeat(40) }),
    /SHA/,
  );
});

test("raw discovery download sends no auth, rejects redirects, and enforces hash and cap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "discovery-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("index bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = discoveryUrl(repository, branch);
  const outputPath = join(directory, "index.json");
  await downloadVerifiedDiscovery(
    { url, sha256, outputPath, maxBytes: bytes.length, timeoutMs: 1000 },
    {
      fetchImpl: async (requested, options) => {
        assert.equal(requested, url);
        assert.equal(options.redirect, "manual");
        assert.equal(options.credentials, "omit");
        assert.equal(options.headers.authorization, undefined);
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      },
    },
  );
  assert.deepEqual(await readFile(outputPath), bytes);
  const redirectError = await downloadVerifiedDiscovery(
    { url, sha256, outputPath: join(directory, "redirect"), timeoutMs: 1000 },
    {
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.invalid/?token=x" },
        }),
    },
  ).catch((error) => error);
  assert.match(redirectError.message, /request failed/);
  assert.doesNotMatch(redirectError.message, /evil|token/);
  await assert.rejects(
    downloadVerifiedDiscovery({ url, sha256, outputPath: "x", maxBytes: 1024 * 1024 + 1 }),
    /size limit/,
  );
  await assert.rejects(
    downloadVerifiedArchive({ url, sha256, outputPath: "x", maxBytes: bytes.length }),
    /not a GitHub release archive|not permitted/,
  );
});
