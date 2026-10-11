import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stagePublication } from "../scripts/publication/stage.mjs";
import { canonicalJson, validateSignedIndex } from "../scripts/lib.mjs";
import { startGitHubFixture } from "./helpers/github-server.mjs";

const cli = fileURLToPath(new URL("../scripts/mirror-publication.mjs", import.meta.url));
const catalogCli = fileURLToPath(
  new URL("../scripts/sign-publication-catalog.mjs", import.meta.url),
);
const token = "fixture-token-not-a-real-credential";
const commit = "b".repeat(40);

async function makeInput(directory) {
  const bytes = Buffer.from("inert archive fixture, never executed");
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const target = pkg.agent.distribution.binary["darwin-aarch64"];
  target.archive = `${pkg.agent.repository}/releases/download/v0.1.0/archive.tar.gz`;
  target.sha256 = createHash("sha256").update(bytes).digest("hex");
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "Fixture only.",
  };
  const input = path.join(directory, "submission.json");
  const stage = path.join(directory, "stage");
  await writeFile(input, JSON.stringify(submission));
  await stagePublication(submission, "acme/registry", stage, {
    download: async ({ outputPath }) => {
      await writeFile(outputPath, bytes, { flag: "wx" });
    },
  });
  return { input, stage };
}

async function bridgeFile(directory, url) {
  const file = path.join(directory, "github-bridge.mjs");
  await writeFile(
    file,
    `
const networkFetch = globalThis.fetch;
const routes = {"github.com":"/public", "api.github.com":"/api", "uploads.github.com":"/uploads", "release-assets.githubusercontent.com":"/cdn"};
globalThis.fetch = async (input, options) => {
  const target = new URL(input);
  if (!routes[target.hostname]) throw new Error("unexpected fixture destination");
  const result = await networkFetch(${JSON.stringify(url)} + routes[target.hostname] + target.pathname + target.search, options);
  return new Response(result.body, {status: result.status, headers: result.headers});
};
`,
  );
  return file;
}

function runCli(bridge, input, directory, publishTag) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        bridge,
        publishTag
          ? fileURLToPath(new URL("../scripts/promote-publication.mjs", import.meta.url))
          : cli,
        ...(publishTag ? ["--confirm-publish", publishTag] : []),
        "--submission",
        input,
        "--repository",
        "acme/registry",
        "--registry-commit",
        commit,
        "--directory",
        directory,
        "--confirm-repository",
        "acme/registry",
      ],
      {
        timeout: 20_000,
        env: { PATH: process.env.PATH, CADENCR_REGISTRY_GITHUB_TOKEN: token },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}

function runCatalogCli(bridge, { manifest, generatedAt, expiresAt, privateKey, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        bridge,
        catalogCli,
        "--manifest",
        manifest,
        "--generated-at",
        generatedAt,
        "--expires-at",
        expiresAt,
        "--private-key",
        privateKey,
        "--key-id",
        "fixture-2026",
        "--output",
        output,
      ],
      {
        timeout: 20_000,
        // Catalog verification is deliberately uncredentialed. In particular, do not
        // inherit the token used by the preceding mirror/promotion child processes.
        env: { PATH: process.env.PATH },
      },
    );
    let outputText = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      outputText += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      outputText += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output: outputText }));
  });
}

test("mirror CLI uploads a draft to a fake API, verifies CDN bytes without credentials, and safely retries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-mirror-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, url } = await startGitHubFixture(t, token);
  const bridge = await bridgeFile(directory, url);
  const { input, stage } = await makeInput(directory);
  const first = await runCli(bridge, input, stage);
  assert.equal(first.status, 0, first.output);
  assert.doesNotMatch(first.output, new RegExp(token));
  assert.equal(state.release.draft, true);
  assert.equal(state.release.make_latest, "false");
  assert.equal(state.release.target_commitish, commit);
  assert.equal(state.assets.length, 2);
  const posts = state.requests.filter((entry) => entry.method === "POST").length;
  assert.equal(posts, 3);
  assert.ok(state.requests.some((entry) => entry.path.startsWith("/cdn/") && !entry.auth));
  const receiptPath = path.join(stage, "mirror-receipt.json");
  const receipt = await readFile(receiptPath, "utf8");
  assert.equal(JSON.parse(receipt).status, "draft_verified");
  const replay = await runCli(bridge, input, stage);
  assert.equal(replay.status, 0, replay.output);
  assert.equal(state.requests.filter((entry) => entry.method === "POST").length, posts);
  assert.equal(await readFile(receiptPath, "utf8"), receipt);
  state.assets[0].bytes = Buffer.from("corrupted remote fixture");
  const corrupt = await runCli(bridge, input, stage);
  assert.equal(corrupt.status, 1, corrupt.output);
  assert.equal(state.requests.filter((entry) => entry.method === "POST").length, posts);
  assert.equal(await readFile(receiptPath, "utf8"), receipt);
  assert.ok(state.requests.every((entry) => !["DELETE", "PATCH"].includes(entry.method)));
});

test("promotion CLI verifies public bytes and resumes after public availability failure without republishing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-promote-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, url } = await startGitHubFixture(t, token);
  const bridge = await bridgeFile(directory, url);
  const { input, stage } = await makeInput(directory);
  const mirrored = await runCli(bridge, input, stage);
  assert.equal(mirrored.status, 0, mirrored.output);
  const mirrorReceipt = await readFile(path.join(stage, "mirror-receipt.json"), "utf8");
  const tag = state.release.tag_name;
  const requestsBefore = state.requests.length;
  const unconfirmed = await runCli(bridge, input, stage, "wrong-tag");
  assert.equal(unconfirmed.status, 1, unconfirmed.output);
  assert.match(unconfirmed.output, /publish confirmation/);
  assert.equal(state.requests.length, requestsBefore);
  state.tagCommit = "c".repeat(40);
  const conflict = await runCli(bridge, input, stage, tag);
  assert.equal(conflict.status, 1, conflict.output);
  assert.equal(state.requests.filter((r) => r.method === "PATCH").length, 0);
  state.tagCommit = commit;
  state.publicUnavailable = true;
  const unavailable = await runCli(bridge, input, stage, tag);
  assert.equal(unavailable.status, 1, unavailable.output);
  assert.equal(state.release.draft, false);
  await assert.rejects(readFile(path.join(stage, "publication-receipt.json")), { code: "ENOENT" });
  state.publicUnavailable = false;
  const recovered = await runCli(bridge, input, stage, tag);
  assert.equal(recovered.status, 0, recovered.output);
  const receipt = await readFile(path.join(stage, "publication-receipt.json"), "utf8");
  const replay = await runCli(bridge, input, stage, tag);
  assert.equal(replay.status, 0, replay.output);
  assert.equal(await readFile(path.join(stage, "publication-receipt.json"), "utf8"), receipt);
  assert.equal(await readFile(path.join(stage, "mirror-receipt.json"), "utf8"), mirrorReceipt);
  assert.equal(state.requests.filter((r) => r.method === "PATCH").length, 1);
  assert.ok(state.requests.some((r) => r.path.startsWith("/public/") && !r.auth));
  assert.ok(state.requests.every((r) => r.method !== "DELETE"));
  assert.doesNotMatch(recovered.output + replay.output, new RegExp(token));
});

test("catalog CLI re-verifies published archives before reading its signing key", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-catalog-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, url } = await startGitHubFixture(t, token);
  const bridge = await bridgeFile(directory, url);
  const { input, stage } = await makeInput(directory);
  const mirrored = await runCli(bridge, input, stage);
  assert.equal(mirrored.status, 0, mirrored.output);
  const promoted = await runCli(bridge, input, stage, state.release.tag_name);
  assert.equal(promoted.status, 0, promoted.output);

  const manifest = path.join(directory, "publication-manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schema_version: 1,
      repository: "acme/registry",
      publications: [{ submission: input, directory: stage, registry_commit: commit }],
    }),
  );
  const wholeSecond = Math.floor(Date.now() / 1000) * 1000;
  const generatedAt = new Date(wholeSecond - 60_000).toISOString().replace(".000Z", "Z");
  const expiresAt = new Date(wholeSecond + 86_400_000).toISOString().replace(".000Z", "Z");
  const options = { directory, state, bridge, manifest, generatedAt, expiresAt };
  await assertCatalogPublicFailures(options);
  await assertSignedCatalog(options);
});

async function assertCatalogPublicFailures(options) {
  const { directory, state, bridge, manifest, generatedAt, expiresAt } = options;
  const missingKey = path.join(directory, "must-not-be-read.pem");
  const runFailure = async (name, pattern) => {
    const output = path.join(directory, `${name}.json`);
    const requestStart = state.requests.length;
    const result = await runCatalogCli(bridge, {
      manifest,
      generatedAt,
      expiresAt,
      privateKey: missingKey,
      output,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, pattern);
    assert.doesNotMatch(result.output, /private key|ENOENT|no such file/i);
    await assert.rejects(readFile(output), { code: "ENOENT" });
    assertUncredentialedReadOnlyRequests(state.requests.slice(requestStart), result.output);
  };
  state.publicUnavailable = true;
  await runFailure("missing-public", /public/i);
  state.publicUnavailable = false;
  const originalBytes = state.assets[0].bytes;
  state.assets[0].bytes = Buffer.from("corrupt public catalog fixture");
  await runFailure("corrupt-public", /hash|sha-?256|digest/i);
  state.assets[0].bytes = originalBytes;
}

async function assertSignedCatalog(options) {
  const { directory, state, bridge, manifest, generatedAt, expiresAt } = options;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(directory, "catalog-private.pem");
  await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  const output = path.join(directory, "catalog.json");
  const validStart = state.requests.length;
  const valid = await runCatalogCli(bridge, {
    manifest,
    generatedAt,
    expiresAt,
    privateKey: privateKeyFile,
    output,
  });
  assert.equal(valid.status, 0, valid.output);
  assertUncredentialedReadOnlyRequests(state.requests.slice(validStart));
  const envelopeText = await readFile(output, "utf8");
  const envelope = JSON.parse(envelopeText);
  assert.deepEqual(validateSignedIndex(envelope), []);
  assert.equal(envelope.signed.generated_at, generatedAt);
  assert.equal(envelope.signed.expires_at, expiresAt);
  assert.equal(envelope.signature.key_id, "fixture-2026");
  const spki = publicKey.export({ format: "der", type: "spki" });
  assert.equal(
    verify(
      null,
      Buffer.from(canonicalJson(envelope.signed)),
      { key: spki, format: "der", type: "spki" },
      Buffer.from(envelope.signature.value, "base64"),
    ),
    true,
  );
  const archives = Object.values(envelope.signed.packages[0].agent.distribution.binary).map(
    (target) => target.archive,
  );
  assert.ok(archives.every((archive) => archive.startsWith("https://github.com/acme/registry/")));
  assert.ok(
    archives.every((archive) =>
      state.assets.some(
        (asset) => asset.browser_download_url === archive && asset.name !== "publication-plan.json",
      ),
    ),
  );
  for (const target of Object.values(envelope.signed.packages[0].agent.distribution.binary)) {
    const asset = state.assets.find((entry) => entry.browser_download_url === target.archive);
    assert.equal(createHash("sha256").update(asset.bytes).digest("hex"), target.sha256);
  }

  const sentinel = `${envelopeText}preserve-on-refusal`;
  await writeFile(output, sentinel);
  const overwrite = await runCatalogCli(bridge, {
    manifest,
    generatedAt,
    expiresAt,
    privateKey: privateKeyFile,
    output,
  });
  assert.equal(overwrite.status, 1, overwrite.output);
  assert.equal(await readFile(output, "utf8"), sentinel);

  const retryOutput = path.join(directory, "catalog-retry.json");
  const retry = await runCatalogCli(bridge, {
    manifest,
    generatedAt,
    expiresAt,
    privateKey: privateKeyFile,
    output: retryOutput,
  });
  assert.equal(retry.status, 0, retry.output);
  assert.equal(await readFile(retryOutput, "utf8"), envelopeText);
}

function assertUncredentialedReadOnlyRequests(requests, detail = "") {
  assert.ok(requests.length > 0, `catalog verification must make fresh public requests: ${detail}`);
  assert.ok(requests.every((request) => request.auth === undefined));
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(
    requests.every(
      (request) => request.path.startsWith("/public/") || request.path.startsWith("/cdn/"),
    ),
  );
}
