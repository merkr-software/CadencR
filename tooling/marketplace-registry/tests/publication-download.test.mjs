import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_ARCHIVE_BYTES, downloadVerifiedArchive } from "../scripts/publication/download.mjs";

const RELEASE_URL = "https://github.com/cadencr/example/releases/download/v1/archive.tar.gz";
const bytes = Buffer.from("verified archive");
const digest = createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "cadencr-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "archive.tar.gz");
}

function options(outputPath, overrides = {}) {
  return { url: RELEASE_URL, sha256: digest, outputPath, ...overrides };
}

test("downloads, hashes, syncs, and creates a private file", async (t) => {
  const outputPath = await fixture(t);
  let request;
  const result = await downloadVerifiedArchive(options(outputPath), {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    },
  });
  assert.deepEqual(result, { sha256: digest, size: bytes.length });
  assert.deepEqual(await readFile(outputPath), bytes);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(request.url, RELEASE_URL);
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.credentials, "omit");
  assert.deepEqual(request.init.headers, { "accept-encoding": "identity" });
  assert.equal(MAX_ARCHIVE_BYTES, 256 * 1024 * 1024);
});

test("validates all inputs before fetching or creating output", async (t) => {
  const outputPath = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(bytes);
  };
  const invalid = [
    "http://github.com/a/b/releases/download/v/a.tgz",
    "https://user@github.com/a/b/releases/download/v/a.tgz",
    "https://github.com:444/a/b/releases/download/v/a.tgz",
    "https://github.com/a/b/releases/download/v/a.tgz#fragment",
    "https://github.com.evil.test/a/b/releases/download/v/a.tgz",
    "https://github.com/a/b/archive/v1.tar.gz",
    "https://github.com/a//b/releases/download/v/a.tgz",
  ];
  for (const url of invalid) {
    await assert.rejects(downloadVerifiedArchive(options(outputPath, { url }), { fetchImpl }));
  }
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath, { sha256: "bad" }), { fetchImpl }),
  );
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath, { maxBytes: MAX_ARCHIVE_BYTES + 1 }), {
      fetchImpl,
    }),
    /invalid size limit/,
  );
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath, { timeoutMs: 2_147_483_648 }), { fetchImpl }),
    /invalid timeout/,
  );
  assert.equal(calls, 0);
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
});

test("follows only three allowlisted manual HTTPS redirects and hides query tokens", async (t) => {
  const outputPath = await fixture(t);
  const locations = [
    "https://release-assets.githubusercontent.com/a/file?token=SECRET_ONE",
    "https://objects.githubusercontent.com/a/file?token=SECRET_TWO",
    "https://github.com/a/b/releases/download/v/final.tgz?token=SECRET_THREE",
  ];
  let call = 0;
  await downloadVerifiedArchive(options(outputPath), {
    fetchImpl: async () => {
      const location = locations[call++];
      return location
        ? new Response("redirect", { status: 302, headers: { location } })
        : new Response(bytes);
    },
  });
  assert.equal(call, 4);

  for (const location of [
    "http://objects.githubusercontent.com/file?token=DO_NOT_LEAK",
    "https://127.0.0.1/file?token=DO_NOT_LEAK",
    "https://evil.githubusercontent.com/file?token=DO_NOT_LEAK",
  ]) {
    const anotherPath = `${outputPath}-${Math.random()}`;
    await assert.rejects(
      downloadVerifiedArchive(options(anotherPath), {
        fetchImpl: async () => new Response("redirect", { status: 302, headers: { location } }),
      }),
      (error) => !error.message.includes("DO_NOT_LEAK"),
    );
  }
});

test("rejects a fourth redirect and cancels redirect bodies", async (t) => {
  const outputPath = await fixture(t);
  let cancellations = 0;
  const body = () =>
    new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath), {
      fetchImpl: async () =>
        new Response(body(), {
          status: 302,
          headers: { location: "https://github.com/a/b/releases/download/v/a.tgz" },
        }),
    }),
    /too many redirects/,
  );
  assert.equal(cancellations, 4);
});

test("rejects status, encoding, malformed length, and declared oversize", async (t) => {
  const cases = [
    new Response("no", { status: 404 }),
    new Response(bytes, { headers: { "content-encoding": "gzip" } }),
    new Response(bytes, { headers: { "content-length": "1.5" } }),
    new Response(bytes, { headers: { "content-length": "17" } }),
  ];
  for (const [index, response] of cases.entries()) {
    const outputPath = `${await fixture(t)}-${index}`;
    await assert.rejects(
      downloadVerifiedArchive(options(outputPath, { maxBytes: 16 }), {
        fetchImpl: async () => response,
      }),
    );
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  }
});

test("enforces streaming cap when content length is absent or lies", async (t) => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const outputPath = `${await fixture(t)}-${Object.keys(headers).length}`;
    await assert.rejects(
      downloadVerifiedArchive(options(outputPath, { maxBytes: 4 }), {
        fetchImpl: async () => new Response(Buffer.alloc(5), { headers }),
      }),
      /size limit/,
    );
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  }
});

test("requires the observed body size to equal content length", async (t) => {
  for (const [index, body, declared] of [
    [0, Buffer.from("short"), 9],
    [1, Buffer.from("too long"), 2],
  ]) {
    const outputPath = `${await fixture(t)}-${index}`;
    await assert.rejects(
      downloadVerifiedArchive(
        options(outputPath, {
          sha256: createHash("sha256").update(body).digest("hex"),
          maxBytes: 16,
        }),
        {
          fetchImpl: async () =>
            new Response(body, { headers: { "content-length": String(declared) } }),
        },
      ),
      /content length does not match/,
    );
    await assert.rejects(stat(outputPath), { code: "ENOENT" });
  }
});

test("preserves sanitized primary and body-cancellation failures", async (t) => {
  const outputPath = await fixture(t);
  const response = new Response(
    new ReadableStream({
      cancel() {
        throw new Error("SECRET_CANCEL_DETAIL");
      },
    }),
    { status: 404 },
  );
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath), { fetchImpl: async () => response }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /unexpected status/);
      assert.match(error.errors[1].message, /could not cancel response body/);
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(
        error.errors.some((entry) => entry.message.includes("SECRET")),
        false,
      );
      return true;
    },
  );
});

test("hash mismatch and stream failure remove only the created partial", async (t) => {
  const hashPath = await fixture(t);
  await assert.rejects(
    downloadVerifiedArchive(options(hashPath, { sha256: "0".repeat(64) }), {
      fetchImpl: async () => new Response(bytes),
    }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(hashPath), { code: "ENOENT" });

  const streamPath = `${hashPath}-stream`;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.error(new Error("SECRET_STREAM_DETAIL"));
    },
  });
  await assert.rejects(
    downloadVerifiedArchive(options(streamPath), {
      fetchImpl: async () => new Response(stream),
    }),
    (error) => /response stream failed/.test(error.message) && !error.message.includes("SECRET"),
  );
  await assert.rejects(stat(streamPath), { code: "ENOENT" });
});

test("never overwrites an existing output", async (t) => {
  const outputPath = await fixture(t);
  await writeFile(outputPath, "keep me", { mode: 0o600 });
  let cancelled = false;
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath), {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(outputPath, "utf8"), "keep me");
  assert.equal(cancelled, true);
});

test("timeout covers response headers and streaming body", async (t) => {
  const headerPath = await fixture(t);
  await assert.rejects(
    downloadVerifiedArchive(options(headerPath, { timeoutMs: 10 }), {
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    }),
    /timed out/,
  );

  const bodyPath = `${headerPath}-body`;
  await assert.rejects(
    downloadVerifiedArchive(options(bodyPath, { timeoutMs: 10 }), {
      fetchImpl: async (_url, { signal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
        ),
    }),
    /timed out/,
  );
  await assert.rejects(stat(bodyPath), { code: "ENOENT" });
});

test("partial cleanup errors retain the sanitized download failure", async (t) => {
  const outputPath = await fixture(t);
  const body = {
    async *[Symbol.asyncIterator]() {
      yield bytes;
      await unlink(outputPath);
      await mkdir(outputPath);
      throw new Error("PRIVATE_UPSTREAM_DETAIL");
    },
    async cancel() {},
  };
  await assert.rejects(
    downloadVerifiedArchive(options(outputPath), {
      fetchImpl: async () => ({ status: 200, headers: new Headers(), body }),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /response stream failed; archive partial cleanup failed/);
      assert.doesNotMatch(error.message, /PRIVATE_UPSTREAM_DETAIL/);
      return true;
    },
  );
});
