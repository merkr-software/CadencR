import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubClient } from "../scripts/publication/github.mjs";

const REPOSITORY = "owner/repository";
const TOKEN = "secret-token";

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("validates configuration and identifiers", async () => {
  assert.throws(() => createGitHubClient({ repository: "bad.repo/x", token: TOKEN }), /repository/);
  assert.throws(() => createGitHubClient({ repository: REPOSITORY, token: "bad\ntoken" }), /token/);
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => json([]),
  });
  await assert.rejects(client.listAssets(0), /release id/);
  await assert.rejects(client.verifyAsset({ asset: { id: -1 } }), /asset id/);
});

test("findRelease paginates drafts and rejects duplicate tags", async () => {
  const calls = [];
  const draft = { id: 7, tag_name: "provider-x-v1", draft: true };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return json(
      calls.length === 1 ? Array(99).fill({ id: 1, tag_name: "other" }).concat(draft) : [draft],
    );
  };
  const client = createGitHubClient({ repository: REPOSITORY, token: TOKEN, fetchImpl });
  await assert.rejects(client.findRelease(draft.tag_name), /duplicated/);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.github\.com\//);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.redirect, "manual");
});

test("findRelease enforces pagination and response limits without leaking details", async () => {
  const full = Array(100).fill({ id: 1, tag_name: "other" });
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => json(full),
  });
  await assert.rejects(client.findRelease("missing"), /pagination limit/);
  let calls = 0;
  const bad = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://evil.invalid/?token=secret" },
          })
        : json([]);
    },
  });
  const error = await bad.findRelease("x").catch((value) => value);
  assert.equal(error.status, 302);
  assert.doesNotMatch(error.message, /evil|secret|token=/);
  const oversized = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => new Response(`"${"x".repeat(2 * 1024 * 1024)}"`),
  });
  await assert.rejects(oversized.findRelease("x"), /exceeds 2 MiB/);
  const malformed = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => new Response("not JSON"),
  });
  await assert.rejects(malformed.findRelease("x"), /malformed JSON/);

  const secret = "token=do-not-leak";
  const throwing = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => {
      const injected = new Error(`GitHub API ${secret}`);
      injected.status = 599;
      throw injected;
    },
  });
  const thrown = await throwing.findRelease("x").catch((value) => value);
  assert.doesNotMatch(thrown.message, /do-not-leak|token=/);
  assert.equal(thrown.status, undefined);

  const cancellationSecret = "token=cancel-secret";
  const cancellationFailure = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => ({
      status: 500,
      body: {
        cancel: async () => {
          throw new Error(cancellationSecret);
        },
      },
    }),
  });
  const cancellationError = await cancellationFailure.findRelease("x").catch((value) => value);
  assert.match(cancellationError.message, /response failed/);
  assert.doesNotMatch(cancellationError.message, /cancel-secret|token=/);
  assert.equal(cancellationError.status, undefined);
});

test("createDraft sends the fixed draft payload", async () => {
  let captured;
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return json({ id: 12, tag_name: "v1" }, 201);
    },
  });
  const commit = "a".repeat(40);
  await client.createDraft({ tag: "v1", commit, body: "notes" });
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), {
    tag_name: "v1",
    target_commitish: commit,
    body: "notes",
    name: "v1",
    draft: true,
    prerelease: false,
    make_latest: "false",
  });
});

test("rejects invalid commits and malformed or unbounded assets before use", async () => {
  let fetches = 0;
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => {
      fetches += 1;
      return json([]);
    },
  });
  await assert.rejects(
    client.createDraft({ tag: "v1", commit: "A".repeat(40), body: "notes" }),
    /commit is invalid/,
  );
  await assert.rejects(
    client.verifyAsset({
      asset: { id: 1, name: "a", size: 1, browser_download_url: "https://github.com/x" },
      expectedUrl: "https://github.com/x",
      sha256: "0".repeat(64),
      size: 1,
      outputPath: "unused",
    }),
    /malformed/,
  );
  await assert.rejects(
    client.verifyAsset({
      asset: {
        id: 1,
        name: "a",
        size: 256 * 1024 * 1024 + 1,
        state: "uploaded",
        browser_download_url: "https://github.com/x",
      },
      expectedUrl: "https://github.com/x",
      sha256: "0".repeat(64),
      size: 256 * 1024 * 1024 + 1,
      outputPath: "unused",
    }),
    /malformed/,
  );
  assert.equal(fetches, 0);
});

test("listAssets enforces its ten-page cap", async () => {
  const assets = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `asset-${index}`,
    size: 1,
    state: "uploaded",
    browser_download_url: `https://github.com/o/r/releases/download/v/asset-${index}`,
  }));
  let calls = 0;
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => {
      calls += 1;
      return json(assets);
    },
  });
  await assert.rejects(client.listAssets(1), /pagination limit/);
  assert.equal(calls, 10);
});

test("uploadAsset streams exact bytes and rejects size mismatch and symlinks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-upload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "asset.zip");
  const link = join(directory, "link.zip");
  const bytes = Buffer.from("archive bytes");
  await writeFile(file, bytes);
  await symlink(file, link);
  let uploaded = Buffer.alloc(0);
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async (url, options) => {
      assert.match(url, /^https:\/\/uploads\.github\.com\//);
      for await (const chunk of options.body) uploaded = Buffer.concat([uploaded, chunk]);
      assert.equal(options.headers["content-length"], String(bytes.length));
      return json(
        {
          id: 21,
          name: "asset.zip",
          size: bytes.length,
          state: "uploaded",
          browser_download_url: "https://github.com/o/r/releases/download/v/a",
        },
        201,
      );
    },
  });
  await client.uploadAsset({ releaseId: 3, name: "asset.zip", file, size: bytes.length });
  assert.deepEqual(uploaded, bytes);
  await assert.rejects(
    client.uploadAsset({ releaseId: 3, name: "x", file, size: 1 }),
    /wrong size/,
  );
  await assert.rejects(
    client.uploadAsset({ releaseId: 3, name: "x", file: link, size: bytes.length }),
    /invalid/,
  );

  let redirectCalls = 0;
  const redirecting = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () => {
      redirectCalls += 1;
      return new Response(null, {
        status: 307,
        headers: { location: "https://example.invalid/?token=secret" },
      });
    },
  });
  const redirectError = await redirecting
    .uploadAsset({ releaseId: 3, name: "asset.zip", file, size: bytes.length })
    .catch((value) => value);
  assert.equal(redirectCalls, 1);
  assert.equal(redirectError.status, 307);
  assert.doesNotMatch(redirectError.message, /example|secret|token=/);
});

test("verifyAsset authenticates only the API request and verifies CDN bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "verified.zip");
  const bytes = Buffer.from("verified archive");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expectedUrl = "https://github.com/owner/repository/releases/download/v1/asset.zip";
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    if (seen.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/cdn/asset.zip" },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
  };
  const client = createGitHubClient({ repository: REPOSITORY, token: TOKEN, fetchImpl });
  await client.verifyAsset({
    asset: {
      id: 8,
      name: "asset.zip",
      size: bytes.length,
      state: "uploaded",
      browser_download_url: expectedUrl,
    },
    expectedUrl,
    sha256,
    size: bytes.length,
    outputPath,
  });
  assert.equal(seen[0].url, "https://api.github.com/repos/owner/repository/releases/assets/8");
  assert.equal(seen[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[1].url, "https://objects.githubusercontent.com/cdn/asset.zip");
  assert.equal(seen[1].options.headers.authorization, undefined);
  assert.deepEqual(await readFile(outputPath), bytes);
});

test("verifyAsset removes a partial file after a remote hash mismatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "github-hash-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "partial.zip");
  const bytes = Buffer.from("wrong bytes");
  const expectedUrl = "https://github.com/owner/repository/releases/download/v1/asset.zip";
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: TOKEN,
    fetchImpl: async () =>
      new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }),
  });
  await assert.rejects(
    client.verifyAsset({
      asset: {
        id: 9,
        name: "asset.zip",
        size: bytes.length,
        state: "uploaded",
        browser_download_url: expectedUrl,
      },
      expectedUrl,
      sha256: "0".repeat(64),
      size: bytes.length,
      outputPath,
    }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});
