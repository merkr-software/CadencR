import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { uploadSentryRendererMaps } from "./upload-sentry-renderer-maps.mjs";

const env = {
  SENTRY_AUTH_TOKEN: "test-token",
  SENTRY_URL: "https://de.sentry.io",
  SENTRY_ORG: "test-org",
  SENTRY_PROJECT: "test-project",
};

async function fixture() {
  const rendererDir = await mkdtemp(path.join(os.tmpdir(), "cadencr-sentry-maps-"));
  await mkdir(path.join(rendererDir, "assets"));
  await writeFile(
    path.join(rendererDir, "build-info.json"),
    JSON.stringify({ version: "0.15.1", buildId: "exact-build" }),
  );
  await writeFile(path.join(rendererDir, "assets/index-abc.js"), "throw new Error('bundled');");
  await writeFile(
    path.join(rendererDir, "assets/index-abc.js.map"),
    JSON.stringify({ version: 3, sources: ["source.ts"], mappings: "AAAA" }),
  );
  return rendererDir;
}

test("uploads exact bytes to a regional API with matching release/dist and hidden map headers", async (t) => {
  const rendererDir = await fixture();
  const calls = [];
  const stored = [];
  const server = createServer(async (incoming, response) => {
    if (incoming.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(stored));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const contentType = incoming.headers["content-type"];
    const parsed = contentType.startsWith("multipart/")
      ? await new Response(body, { headers: { "Content-Type": contentType } }).formData()
      : JSON.parse(body.toString());
    calls.push({ url: incoming.url, authorization: incoming.headers.authorization, body: parsed });
    if (parsed instanceof FormData) {
      stored.push({
        name: parsed.get("name"),
        dist: parsed.get("dist"),
        sha1: createHash("sha1")
          .update(Buffer.from(await parsed.get("file").arrayBuffer()))
          .digest("hex"),
      });
    }
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const args = {
    rendererDir,
    env,
    request(url, options) {
      assert.equal(url.origin, "https://de.sentry.io");
      assert.equal(options.redirect, "error");
      return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, options);
    },
  };
  const result = await uploadSentryRendererMaps(args);
  assert.deepEqual(result, {
    skipped: false,
    release: "cadencr@0.15.1",
    dist: "exact-build",
    files: 2,
    unmapped: [],
  });
  assert.deepEqual(calls[0].body, { version: "cadencr@0.15.1", projects: ["test-project"] });
  assert.equal(calls.length, 3);
  for (const [call, suffix] of [
    [calls[1], ".map"],
    [calls[2], ""],
  ]) {
    assert.match(call.url, /cadencr%400\.15\.1\/files\/$/);
    assert.equal(call.authorization, "Bearer test-token");
    assert.equal(call.body.get("name"), `~/assets/index-abc.js${suffix}`);
    assert.equal(call.body.get("dist"), "exact-build");
    assert.equal(
      await call.body.get("file").text(),
      await readFile(path.join(rendererDir, `assets/index-abc.js${suffix}`), "utf8"),
    );
  }
  assert.equal(calls[2].body.get("header"), "Sourcemap:~/assets/index-abc.js.map");
  await uploadSentryRendererMaps(args);
  assert.equal(calls.length, 4, "a rerun creates/reuses the release and skips identical files");
  assert.equal(stored.length, 2);
});

test("standalone uploader preserves mapless workers and never advertises fabricated maps", async () => {
  const rendererDir = await fixture();
  const workers = ["z-worker.js", "a-worker.js"];
  for (const name of workers) await writeFile(path.join(rendererDir, "assets", name), `// ${name}`);
  const copied = path.join(await mkdtemp(path.join(os.tmpdir(), "cadencr-uploader-")), "tool.mjs");
  await copyFile(new URL("./upload-sentry-renderer-maps.mjs", import.meta.url), copied);
  const { uploadSentryRendererMaps: standalone } = await import(pathToFileURL(copied).href);
  const uploaded = [];
  const stored = [];
  const request = async (url, options) => {
    assert.equal(url.origin, "https://de.sentry.io");
    assert.equal(options.redirect, "error");
    if (options.method === "GET") return Response.json(stored);
    if (options.body instanceof FormData) {
      uploaded.push(options.body);
      stored.push({
        name: options.body.get("name"),
        dist: options.body.get("dist"),
        sha1: createHash("sha1")
          .update(Buffer.from(await options.body.get("file").arrayBuffer()))
          .digest("hex"),
      });
    }
    return new Response("{}", { status: 201 });
  };
  const args = { rendererDir, env, request };
  const result = await standalone(args);
  assert.deepEqual(result.unmapped, [...workers].sort());
  assert.equal(result.files, 4);
  for (const name of workers) {
    const artifact = uploaded.find((body) => body.get("name") === `~/assets/${name}`);
    assert.equal(await artifact.get("file").text(), `// ${name}`);
    assert.equal(artifact.get("header"), null);
    assert.equal(await readFile(path.join(rendererDir, "assets", name), "utf8"), `// ${name}`);
    assert.ok(!uploaded.some((body) => body.get("name") === `~/assets/${name}.map`));
  }
  assert.equal(
    uploaded.find((body) => body.get("name") === "~/assets/index-abc.js").get("header"),
    "Sourcemap:~/assets/index-abc.js.map",
  );
  assert.deepEqual(await standalone(args), result);
  assert.equal(uploaded.length, 4, "identical unmapped bundles are also skipped on retry");
});

test("missing entry maps and invalid maps after an unmapped worker fail before any request", async () => {
  for (const scenario of ["index", "notch", "invalid", "directory"]) {
    const rendererDir = await fixture();
    const assets = path.join(rendererDir, "assets");
    await writeFile(path.join(assets, "a-worker.js"), "// no source map");
    if (scenario === "index") await unlink(path.join(assets, "index-abc.js.map"));
    else if (scenario === "notch") await writeFile(path.join(assets, "notch-abc.js"), "// entry");
    else {
      await writeFile(path.join(assets, "z-worker.js"), "// worker");
      if (scenario === "directory") await mkdir(path.join(assets, "z-worker.js.map"));
      else await writeFile(path.join(assets, "z-worker.js.map"), '{"version":2}');
    }
    let requests = 0;
    await assert.rejects(
      uploadSentryRendererMaps({
        rendererDir,
        env,
        request: async () => {
          requests += 1;
          throw new Error("unexpected request");
        },
      }),
      /entry source map missing|Invalid source map|not a regular file/,
    );
    assert.equal(requests, 0, scenario);
  }
});

test(
  "an unreadable existing map remains an error before any request",
  {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async () => {
    const rendererDir = await fixture();
    const map = path.join(rendererDir, "assets/index-abc.js.map");
    let requests = 0;
    await chmod(map, 0);
    try {
      await assert.rejects(
        uploadSentryRendererMaps({
          rendererDir,
          env,
          request: async () => {
            requests += 1;
            throw new Error("unexpected request");
          },
        }),
        (error) => error.code === "EACCES",
      );
    } finally {
      await chmod(map, 0o600);
    }
    assert.equal(requests, 0);
  },
);

test("existing files are paginated; same name in another dist is ignored and conflicting bytes fail", async () => {
  const rendererDir = await fixture();
  let pages = 0;
  let uploads = 0;
  const request = async (url, options) => {
    if (!url.pathname.endsWith("/files/")) return new Response("{}", { status: 208 });
    if (options.method === "POST") {
      uploads += 1;
      return new Response("{}", { status: 201 });
    }
    pages += 1;
    if (!url.search)
      return Response.json(
        [{ name: "~/assets/index-abc.js", dist: "another-build", sha1: "other" }],
        {
          headers: {
            Link: '<https://de.sentry.io/files/?cursor=page2>; rel="next"; results="true"; cursor="page2"',
          },
        },
      );
    assert.equal(url.searchParams.get("cursor"), "page2");
    return Response.json([
      { name: "~/assets/index-abc.js.map", dist: "exact-build", sha1: "conflicting-bytes" },
    ]);
  };
  await assert.rejects(
    uploadSentryRendererMaps({ rendererDir, env, request }),
    /Conflicting Sentry release artifact/,
  );
  assert.equal(pages, 2);
  assert.equal(uploads, 0);
});

test("missing or nonstring build metadata fails before network requests", async () => {
  const rendererDir = await fixture();
  for (const info of [
    {},
    { version: 1, buildId: "id" },
    { version: "undefined", buildId: "id" },
    { version: "1.2.3", buildId: 1 },
  ]) {
    await writeFile(path.join(rendererDir, "build-info.json"), JSON.stringify(info));
    await assert.rejects(
      uploadSentryRendererMaps({
        rendererDir,
        env,
        request: () => {
          throw new Error("unexpected request");
        },
      }),
      /Invalid renderer build metadata/,
    );
  }
});

test("missing credentials skip all reads; partial credentials and foreign token destinations fail", async () => {
  assert.deepEqual(await uploadSentryRendererMaps({ rendererDir: "/missing", env: {} }), {
    skipped: true,
  });
  await assert.rejects(
    uploadSentryRendererMaps({ env: { SENTRY_AUTH_TOKEN: "test" } }),
    /SENTRY_ORG/,
  );
  for (const url of [
    "http://de.sentry.io",
    "https://example.com",
    "https://de.sentry.io/?token=test",
  ]) {
    await assert.rejects(
      uploadSentryRendererMaps({ env: { ...env, SENTRY_URL: url } }),
      /SENTRY_URL/,
    );
  }
});

test("invalid maps fail before upload; provider failures expose only HTTP status", async () => {
  const rendererDir = await fixture();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return new Response("private provider text", { status: 403 });
  };
  await assert.rejects(
    uploadSentryRendererMaps({ rendererDir, env, request }),
    /^Error: Sentry source-map upload failed \(HTTP 403\)$/,
  );
  assert.equal(calls, 1);
  await writeFile(path.join(rendererDir, "assets/index-abc.js.map"), '{"version":2}');
  await assert.rejects(
    uploadSentryRendererMaps({ rendererDir, env, request }),
    /Invalid source map/,
  );
  assert.equal(calls, 1);
});

for (const name of ["desktop-release.yml", "desktop-linux-release.yml"]) {
  test(`${name} keeps telemetry public configuration in Rust builds and uploader credentials in one step`, async () => {
    const workflow = parse(await readFile(`.github/workflows/${name}`, "utf8"));
    const job = workflow.jobs.release ?? workflow.jobs.build;
    const config = { ...workflow.env, ...job.env };
    assert.equal(config.CADENCR_SENTRY_UPLOAD_CONFIGURED, "${{ secrets.SENTRY_AUTH_TOKEN != '' }}");
    for (const key of ["CADENCR_SENTRY_DSN", "CADENCR_POSTHOG_KEY", "CADENCR_POSTHOG_HOST"]) {
      assert.equal(config[key], `\${{ vars.${key} }}`);
    }
    assert.equal(config.CADENCR_TELEMETRY_DEV_ENABLED, undefined);
    const steps = job.steps;
    const uploadIndex = steps.findIndex(
      (step) => step.name === "Upload optional Sentry renderer source maps",
    );
    const archiveIndex = steps.findIndex(
      (step) => step.name === "Archive exact renderer bundles and source maps",
    );
    const loadIndex = steps.findIndex(
      (step) => step.name === "Load Sentry uploader from workflow commit",
    );
    assert.ok(uploadIndex > loadIndex && loadIndex > archiveIndex);
    for (const index of [loadIndex, uploadIndex]) {
      assert.equal(steps[index].if, "env.CADENCR_SENTRY_UPLOAD_CONFIGURED == 'true'");
    }
    assert.match(steps[loadIndex].run, /set -euo pipefail/);
    assert.match(steps[loadIndex].run, /upload-sentry-renderer-maps\.mjs\?ref=\$GITHUB_SHA/);
    assert.match(steps[loadIndex].run, /test -s/);
    assert.equal(steps[loadIndex].env.SENTRY_AUTH_TOKEN, undefined);
    assert.equal(steps[loadIndex].env.GH_TOKEN, "${{ github.token }}");
    assert.equal(steps[uploadIndex].run, 'node "$RUNNER_TEMP/cadencr-sentry-uploader.mjs"');
    assert.equal(steps[uploadIndex]["continue-on-error"], undefined);
    assert.equal(
      steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with.ref,
      "refs/tags/${{ env.RELEASE_TAG }}",
    );
    assert.equal(steps[uploadIndex].env.SENTRY_AUTH_TOKEN, "${{ secrets.SENTRY_AUTH_TOKEN }}");
    assert.equal(config.SENTRY_AUTH_TOKEN, undefined);
    assert.equal(steps[uploadIndex].env.SENTRY_URL, "${{ vars.SENTRY_URL }}");
  });
}
