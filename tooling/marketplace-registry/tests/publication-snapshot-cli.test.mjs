import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../scripts/lib.mjs";
import { stagePublication } from "../scripts/publication/stage.mjs";
import { startGitHubFixture } from "./helpers/github-server.mjs";

const token = "snapshot-fixture-token-not-a-real-credential";
const commit = "b".repeat(40);
const keyId = "snapshot-2026";
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

async function bridgeFile(directory, url) {
  const file = path.join(directory, "github-bridge.mjs");
  await writeFile(
    file,
    `
const networkFetch = globalThis.fetch;
const routes = {"raw.githubusercontent.com":"/raw", "github.com":"/public", "api.github.com":"/api", "uploads.github.com":"/uploads", "release-assets.githubusercontent.com":"/cdn"};
globalThis.fetch = async (input, options) => {
  const target = new URL(input);
  if (!routes[target.hostname]) throw new Error("unexpected fixture destination " + target.hostname);
  const result = await networkFetch(${JSON.stringify(url)} + routes[target.hostname] + target.pathname + target.search, options);
  return new Response(result.body, {status: result.status, headers: result.headers});
};
`,
  );
  return file;
}

function run(bridge, script, args, withToken = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", bridge, path.join(scripts, script), ...args],
      {
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          ...(withToken ? { CADENCR_REGISTRY_GITHUB_TOKEN: token } : {}),
        },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}

async function preparePublishedProvider(directory, bridge, state) {
  const archive = Buffer.from("inert snapshot pipeline archive");
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const target = pkg.agent.distribution.binary["darwin-aarch64"];
  target.archive = `${pkg.agent.repository}/releases/download/v0.1.0/provider.tar.gz`;
  target.sha256 = createHash("sha256").update(archive).digest("hex");
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
    changelog: "Snapshot CLI fixture only.",
  };
  const submissionFile = path.join(directory, "submission.json");
  const stage = path.join(directory, "provider-stage");
  await writeFile(submissionFile, JSON.stringify(submission));
  await stagePublication(submission, "acme/registry", stage, {
    download: async ({ outputPath }) => writeFile(outputPath, archive, { flag: "wx" }),
  });
  const common = [
    "--submission",
    submissionFile,
    "--repository",
    "acme/registry",
    "--registry-commit",
    commit,
    "--directory",
    stage,
    "--confirm-repository",
    "acme/registry",
  ];
  const mirrored = await run(bridge, "mirror-publication.mjs", common, true);
  assert.equal(mirrored.status, 0, mirrored.output);
  const providerTag = state.release.tag_name;
  const promoted = await run(
    bridge,
    "promote-publication.mjs",
    ["--confirm-publish", providerTag, ...common],
    true,
  );
  assert.equal(promoted.status, 0, promoted.output);
  return { submissionFile, stage };
}

async function prepareCatalog(directory, bridge, provider) {
  const manifest = path.join(directory, "publication-manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schema_version: 1,
      repository: "acme/registry",
      publications: [
        { submission: provider.submissionFile, directory: provider.stage, registry_commit: commit },
      ],
    }),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(directory, "private.pem");
  const publicKeyFile = path.join(directory, "public.pem");
  await writeFile(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  await writeFile(publicKeyFile, publicKey.export({ format: "pem", type: "spki" }));
  const catalog = path.join(directory, "managed-index-envelope.json");
  const second = Math.floor(Date.now() / 1000) * 1000;
  const signed = await run(bridge, "sign-publication-catalog.mjs", [
    "--manifest",
    manifest,
    "--generated-at",
    new Date(second - 60_000).toISOString().replace(".000Z", "Z"),
    "--expires-at",
    new Date(second + 86_400_000).toISOString().replace(".000Z", "Z"),
    "--private-key",
    privateKeyFile,
    "--key-id",
    keyId,
    "--output",
    catalog,
  ]);
  assert.equal(signed.status, 0, signed.output);
  return { catalog, manifest, publicKeyFile };
}

function publishArgs(
  files,
  directory,
  confirmation,
  previous = "bootstrap",
  catalog = files.catalog,
) {
  return [
    "--catalog",
    catalog,
    "--previous-index",
    previous,
    "--public-key",
    files.publicKeyFile,
    "--key-id",
    keyId,
    "--manifest",
    files.manifest,
    "--repository",
    "acme/registry",
    "--registry-commit",
    commit,
    "--directory",
    directory,
    "--confirm-repository",
    "acme/registry",
    "--confirm-publish",
    confirmation,
  ];
}

test("snapshot CLI publishes one immutable catalog asset and safely resumes public verification", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-snapshot-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, url } = await startGitHubFixture(t, token);
  const bridge = await bridgeFile(directory, url);
  const provider = await preparePublishedProvider(directory, bridge, state);
  const files = await prepareCatalog(directory, bridge, provider);
  const catalogBytes = await readFile(files.catalog);
  const envelope = JSON.parse(catalogBytes);
  const canonicalBytes = Buffer.from(`${canonicalJson(envelope)}\n`);
  const digest = createHash("sha256").update(canonicalBytes).digest("hex");
  const tag = `catalog-${digest}`;
  const outputDirectory = path.join(directory, "catalog-publication");
  await mkdir(outputDirectory);

  const writesBeforeRefusals = state.requests.filter(({ method }) => method !== "GET").length;
  const tampered = path.join(directory, "tampered-catalog.json");
  envelope.signed.packages[0].agent.name = "tampered";
  await writeFile(tampered, JSON.stringify(envelope));
  for (const [args, pattern] of [
    [publishArgs(files, outputDirectory, tag, files.catalog), /strictly increase/],
    [publishArgs(files, outputDirectory, tag, "bootstrap", tampered), /signature verification/],
    [publishArgs(files, outputDirectory, "catalog-wrong"), /publish confirmation/],
  ]) {
    const refused = await run(bridge, "publish-catalog.mjs", args, true);
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, pattern);
    assert.equal(
      state.requests.filter(({ method }) => method !== "GET").length,
      writesBeforeRefusals,
    );
  }

  state.catalogPublicUnavailable = true;
  const requestStart = state.requests.length;
  const unavailable = await run(
    bridge,
    "publish-catalog.mjs",
    publishArgs(files, outputDirectory, tag),
    true,
  );
  assert.equal(unavailable.status, 1, unavailable.output);
  const publicationRequests = state.requests.slice(requestStart);
  assert.equal(
    publicationRequests.filter(({ method }) => method === "POST").length,
    2,
    unavailable.output,
  );
  assert.equal(publicationRequests.filter(({ method }) => method === "PATCH").length, 1);
  assert.ok(publicationRequests.every(({ method }) => method !== "DELETE"));
  await assert.rejects(readFile(path.join(outputDirectory, "catalog-publication-receipt.json")), {
    code: "ENOENT",
  });

  const catalogRelease = state.releases.find((release) => release.tag_name === tag);
  assert.equal(catalogRelease.draft, false);
  assert.equal(catalogRelease.make_latest, "false");
  const catalogAssets = state.assets.filter((asset) => asset.release_id === catalogRelease.id);
  assert.equal(catalogAssets.length, 1);
  assert.equal(catalogAssets[0].name, "managed-index.json");
  assert.deepEqual(catalogAssets[0].bytes, canonicalBytes);

  state.catalogPublicUnavailable = false;
  const patches = state.requests.filter(({ method }) => method === "PATCH").length;
  const recovered = await run(
    bridge,
    "publish-catalog.mjs",
    publishArgs(files, outputDirectory, tag),
    true,
  );
  assert.equal(recovered.status, 0, recovered.output);
  assert.doesNotMatch(recovered.output, new RegExp(token));
  assert.equal(state.requests.filter(({ method }) => method === "PATCH").length, patches);
  assert.ok(
    state.requests.some(
      ({ path: requestPath, auth }) => requestPath.startsWith("/public/") && !auth,
    ),
  );
  const receiptFile = path.join(outputDirectory, "catalog-publication-receipt.json");
  const receipt = await readFile(receiptFile, "utf8");
  assert.equal(JSON.parse(receipt).catalog_sha256, digest);

  const posts = state.requests.filter(({ method }) => method === "POST").length;
  const replay = await run(
    bridge,
    "publish-catalog.mjs",
    publishArgs(files, outputDirectory, tag),
    true,
  );
  assert.equal(replay.status, 0, replay.output);
  assert.equal(state.requests.filter(({ method }) => method === "POST").length, posts);
  assert.equal(state.requests.filter(({ method }) => method === "PATCH").length, patches);
  assert.equal(await readFile(receiptFile, "utf8"), receipt);
  assert.ok(state.requests.every(({ method }) => method !== "DELETE"));
});

test("discovery CLI advances only a published snapshot and reconciles a lost PUT without another write", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-discovery-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { state, url } = await startGitHubFixture(t, token);
  const bridge = await bridgeFile(directory, url);
  const provider = await preparePublishedProvider(directory, bridge, state);
  const files = await prepareCatalog(directory, bridge, provider);
  const bytes = await readFile(files.catalog);
  const tag = `catalog-${createHash("sha256").update(bytes).digest("hex")}`;
  const outputDirectory = path.join(directory, "catalog-publication");
  await mkdir(outputDirectory);
  const common = publishArgs(files, outputDirectory, tag);
  const published = await run(bridge, "publish-catalog.mjs", common, true);
  assert.equal(published.status, 0, published.output);
  const rawUrl =
    "https://raw.githubusercontent.com/acme/registry/refs/heads/catalog/managed-index.json";
  const args = [...common, "--discovery-branch", "catalog", "--confirm-discovery", rawUrl];
  const start = state.requests.length;
  state.loseDiscoveryResponse = true;
  state.rawUnavailable = true;
  const unavailable = await run(bridge, "advance-catalog.mjs", args, true);
  assert.equal(unavailable.status, 1, unavailable.output);
  assert.deepEqual(state.discovery?.bytes, bytes, unavailable.output);
  const receipt = path.join(outputDirectory, "discovery-receipt.json");
  await assert.rejects(readFile(receipt), { code: "ENOENT" });
  state.rawUnavailable = false;
  const recovered = await run(bridge, "advance-catalog.mjs", args, true);
  assert.equal(recovered.status, 0, recovered.output);
  const receiptBytes = await readFile(receipt);
  const replay = await run(bridge, "advance-catalog.mjs", args, true);
  assert.equal(replay.status, 0, replay.output);
  assert.deepEqual(await readFile(receipt), receiptBytes);
  const requests = state.requests.slice(start);
  assert.equal(requests.filter(({ method }) => method === "PUT").length, 1);
  assert.ok(requests.every(({ method }) => ["GET", "PUT"].includes(method)));
  assert.ok(requests.some(({ path: pathname, auth }) => pathname.startsWith("/raw/") && !auth));
  assert.doesNotMatch(unavailable.output + recovered.output + replay.output, new RegExp(token));
});
