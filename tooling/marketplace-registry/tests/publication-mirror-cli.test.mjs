import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stagePublication } from "../scripts/publication/stage.mjs";
import { startGitHubFixture } from "./helpers/github-server.mjs";

const cli = fileURLToPath(new URL("../scripts/mirror-publication.mjs", import.meta.url));
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
