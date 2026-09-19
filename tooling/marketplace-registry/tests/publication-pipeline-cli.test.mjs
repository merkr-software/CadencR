import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bridgeFile, runRegistryCli } from "./helpers/cli.mjs";
import { startGitHubFixture } from "./helpers/github-server.mjs";

const token = "pipeline-fixture-token-not-real";
const commit = "b".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function prepareRequest(directory, state) {
  const archive = Buffer.from("inert full pipeline fixture archive");
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  const target = pkg.agent.distribution.binary["darwin-aarch64"];
  target.archive = `${pkg.agent.repository}/releases/download/v0.1.0/provider.tar.gz`;
  target.sha256 = digest(archive);
  state.sourceArchives.set(`/public${new URL(target.archive).pathname}`, archive);
  await writeFile(
    path.join(directory, "submission.json"),
    JSON.stringify({
      schema_version: 1,
      package: pkg,
      source: { repository: pkg.agent.repository, commit: "a".repeat(40), tag: "v0.1.0" },
      changelog: "Full pipeline fixture only.",
    }),
  );
  const keys = generateKeyPairSync("ed25519");
  await writeFile(
    path.join(directory, "private.pem"),
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  await writeFile(
    path.join(directory, "public.pem"),
    keys.publicKey.export({ format: "pem", type: "spki" }),
  );
  const now = Math.floor(Date.now() / 1000) * 1000;
  const date = (offset) => new Date(now + offset).toISOString().replace(".000Z", "Z");
  const request = {
    schema_version: 1,
    repository: "acme/registry",
    key_id: "pipeline-2026",
    discovery_branch: "catalog",
    generated_at: date(-60_000),
    expires_at: date(86_400_000),
    previous_index: "bootstrap",
    public_key: "public.pem",
    publications: [{ submission: "submission.json" }],
  };
  const bytes = JSON.stringify(request);
  await writeFile(path.join(directory, "publication-request.json"), bytes);
  return [
    "--request",
    path.join(directory, "publication-request.json"),
    "--directory",
    path.join(directory, "state"),
    "--repository",
    "acme/registry",
    "--registry-commit",
    commit,
    "--private-key",
    path.join(directory, "private.pem"),
    "--confirm-request-sha256",
    digest(bytes),
  ];
}

test("actual protected publisher CLI verifies a full publication and recovers discovery without repeating writes", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "registry-pipeline-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await startGitHubFixture(t, token);
  fixture.state.strictTags = true;
  const bridge = await bridgeFile(directory, fixture.url);
  const args = await prepareRequest(directory, fixture.state);
  fixture.state.publicUnavailable = true;
  const unpublished = await runRegistryCli(bridge, "publish-registry.mjs", args, token);
  assert.notEqual(unpublished.status, 0, unpublished.output);
  assert.equal(fixture.state.releases.length, 1, unpublished.output);
  await assert.rejects(readFile(path.join(directory, "state", "managed-index.json")), {
    code: "ENOENT",
  });
  fixture.state.publicUnavailable = false;
  fixture.state.rawUnavailable = true;
  fixture.state.loseDiscoveryResponse = true;
  const failed = await runRegistryCli(bridge, "publish-registry.mjs", args, token);
  assert.notEqual(failed.status, 0, failed.output);
  assert.equal(fixture.state.releases.length, 2, failed.output);
  assert.ok(fixture.state.releases.every((release) => release.draft === false));
  assert.ok(fixture.state.discovery, failed.output);
  const writes = () => fixture.state.requests.filter(({ method }) => method !== "GET");
  const initialWrites = writes().length;
  fixture.state.rawUnavailable = false;
  const recovered = await runRegistryCli(bridge, "publish-registry.mjs", args, token);
  assert.equal(recovered.status, 0, recovered.output);
  const replay = await runRegistryCli(bridge, "publish-registry.mjs", args, token);
  assert.equal(replay.status, 0, replay.output);
  assert.equal(writes().length, initialWrites);
  assert.equal(fixture.state.tags.size, 2);
  assert.ok(writes().every(({ method }) => ["POST", "PATCH", "PUT"].includes(method)));
  for (const result of [unpublished, failed, recovered, replay]) {
    assert.doesNotMatch(result.output, /PRIVATE KEY/);
    assert.ok(!result.output.includes(token));
  }
  const before = fixture.state.requests.length;
  const bad = await runRegistryCli(
    bridge,
    "publish-registry.mjs",
    [...args.slice(0, -1), "0".repeat(64)],
    token,
  );
  assert.notEqual(bad.status, 0);
  assert.equal(fixture.state.requests.length, before);
});

test("a later tag conflict preserves earlier publication but never signs or advertises the incomplete catalogue", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "registry-conflict-cli-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = await startGitHubFixture(t, token);
  fixture.state.strictTags = true;
  const bridge = await bridgeFile(directory, fixture.url);
  const args = await prepareRequest(directory, fixture.state);
  const submission = JSON.parse(await readFile(path.join(directory, "submission.json"), "utf8"));
  submission.package.agent.id = "another-provider";
  await writeFile(path.join(directory, "second.json"), JSON.stringify(submission));
  const requestFile = path.join(directory, "publication-request.json");
  const request = JSON.parse(await readFile(requestFile, "utf8"));
  request.publications.push({ submission: "second.json" });
  const bytes = JSON.stringify(request);
  await writeFile(requestFile, bytes);
  args[args.length - 1] = digest(bytes);
  fixture.state.tags.set("provider-another-provider-v0.1.0", "c".repeat(40));
  const result = await runRegistryCli(bridge, "publish-registry.mjs", args, token);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /tag commit conflicts/);
  assert.equal(fixture.state.releases.length, 1);
  assert.equal(fixture.state.releases[0].draft, false);
  assert.equal(fixture.state.discovery, null);
  assert.equal(fixture.state.tags.get("provider-another-provider-v0.1.0"), "c".repeat(40));
  await assert.rejects(readFile(path.join(directory, "state", "managed-index.json")), {
    code: "ENOENT",
  });
});
