import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/stage-publication.mjs", import.meta.url));

async function startFixtureServer(t, bytes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/source") {
      response.writeHead(302, {
        location: "https://release-assets.githubusercontent.com/fixture/archive?opaque=fixture",
      });
      response.end();
    } else {
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, 7));
      response.end(bytes.subarray(7));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function writeBridge(directory, url) {
  const bridge = path.join(directory, "fetch-bridge.mjs");
  // Test-only routing preserves real HTTP streaming without contacting GitHub.
  // The production CLI exposes no transport override or HTTP downgrade flag.
  await writeFile(
    bridge,
    `
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const target = new URL(input);
  if (!["github.com", "release-assets.githubusercontent.com"].includes(target.hostname)) {
    throw new Error("unexpected fixture host");
  }
  const route = target.hostname === "github.com" ? "/source" : "/asset";
  const response = await networkFetch(${JSON.stringify(url)} + route, options);
  return new Response(response.body, {status: response.status, headers: response.headers});
};
`,
  );
  return bridge;
}

function runCli(bridge, input, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        bridge,
        cli,
        "--submission",
        input,
        "--repository",
        "acme/registry",
        "--directory",
        directory,
      ],
      { timeout: 15_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("staging CLI streams HTTP fixtures, resumes without requests, and refuses corrupted finals", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-publication-transfer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("inert archive fixture: never extract or execute these bytes");
  const server = await startFixtureServer(t, bytes);
  const bridge = await writeBridge(directory, server.url);
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const target = pkg.agent.distribution.binary["darwin-aarch64"];
  target.archive = `${pkg.agent.repository}/releases/download/v0.1.0/provider.tar.gz`;
  target.sha256 = createHash("sha256").update(bytes).digest("hex");
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "Test only.",
  };
  const input = path.join(directory, "submission.json");
  const stage = path.join(directory, "staged");
  await writeFile(input, JSON.stringify(submission));
  const first = await runCli(bridge, input, stage);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(server.requests.length, 2);
  assert.ok(server.requests.every((request) => request.authorization === undefined));
  const receiptPath = path.join(stage, "staging-receipt.json");
  const receiptText = await readFile(receiptPath, "utf8");
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.plan.source.submission, submission);
  const final = path.join(stage, receipt.artifacts[0].asset);
  assert.deepEqual(await readFile(final), bytes);
  assert.equal((await runCli(bridge, input, stage)).status, 0);
  assert.equal(server.requests.length, 2, "verified retry must not download again");
  assert.equal(await readFile(receiptPath, "utf8"), receiptText);
  await writeFile(final, "corrupted test fixture");
  const corrupt = await runCli(bridge, input, stage);
  assert.equal(corrupt.status, 1);
  assert.equal(server.requests.length, 2);
  assert.equal(await readFile(final, "utf8"), "corrupted test fixture");
  assert.equal(await readFile(receiptPath, "utf8"), receiptText);
  assert.ok((await readdir(stage)).every((name) => !name.startsWith(".")));
});
