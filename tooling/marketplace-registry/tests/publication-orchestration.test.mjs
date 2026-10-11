import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPublicationPipeline } from "../scripts/publication/pipeline.mjs";

const commit = "a".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "publication-pipeline-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "private.pem");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(path.join(root, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  return { root, privateKeyFile };
}

function request(overrides = {}) {
  return {
    schema_version: 1,
    repository: "cadencr/registry",
    key_id: "registry",
    discovery_branch: "catalog",
    generated_at: "2030-01-01T00:00:00Z",
    expires_at: "2030-01-02T00:00:00Z",
    previous_index: "bootstrap",
    public_key: "public.pem",
    publications: [{ submission: "missing.json" }],
    ...overrides,
  };
}

function options(root, privateKeyFile, bytes, client) {
  return {
    requestFile: path.join(root, "request.json"),
    directory: path.join(root, "state"),
    repository: "cadencr/registry",
    registryCommit: commit,
    privateKeyFile,
    confirmRequestSha256: digest(bytes),
    client,
    now: new Date("2030-01-01T00:01:00Z"),
  };
}

function clientCountingWrites(counter) {
  const client = {};
  for (const method of [
    "findRelease",
    "createDraft",
    "listAssets",
    "uploadAsset",
    "verifyAsset",
    "getTagCommit",
    "publishDraft",
    "getDiscovery",
    "setDiscovery",
  ]) {
    client[method] = async () => {
      counter.count += 1;
    };
  }
  client.ensurePublicationTag = async () => {
    counter.count += 1;
  };
  return client;
}

test("rejects an unconfirmed raw request before state or remote writes", async (t) => {
  const { root, privateKeyFile } = await fixture(t);
  const bytes = Buffer.from(`${JSON.stringify(request())}\n`);
  await writeFile(path.join(root, "request.json"), bytes);
  const remoteWrites = { count: 0 };
  const client = clientCountingWrites(remoteWrites);
  await assert.rejects(
    runPublicationPipeline({
      ...options(root, privateKeyFile, bytes, client),
      confirmRequestSha256: "0".repeat(64),
    }),
    /SHA-256 confirmation/,
  );
  assert.equal(remoteWrites.count, 0);
  await assert.rejects(access(path.join(root, "state")), { code: "ENOENT" });
});

test("rejects traversal in trusted request paths before remote writes", async (t) => {
  const { root, privateKeyFile } = await fixture(t);
  const bytes = Buffer.from(`${JSON.stringify(request({ public_key: "../public.pem" }))}\n`);
  await writeFile(path.join(root, "request.json"), bytes);
  const remoteWrites = { count: 0 };
  const client = clientCountingWrites(remoteWrites);
  await assert.rejects(
    runPublicationPipeline(options(root, privateKeyFile, bytes, client)),
    /safe relative path/,
  );
  assert.equal(remoteWrites.count, 0);
});

for (const [label, override, pattern] of [
  ["invalid discovery branch", { discovery_branch: "bad..branch" }, /discovery branch/],
  ["invalid signing key id", { key_id: "BAD KEY" }, /signing key id/],
]) {
  test(`rejects ${label} before remote writes`, async (t) => {
    const { root, privateKeyFile } = await fixture(t);
    const bytes = Buffer.from(`${JSON.stringify(request(override))}\n`);
    await writeFile(path.join(root, "request.json"), bytes);
    const remoteWrites = { count: 0 };
    await assert.rejects(
      runPublicationPipeline(
        options(root, privateKeyFile, bytes, clientCountingWrites(remoteWrites)),
      ),
      pattern,
    );
    assert.equal(remoteWrites.count, 0);
  });
}

async function validFixture(t, override = {}) {
  const state = await fixture(t);
  const pkg = JSON.parse(
    await readFile(new URL("fixtures/example-provider.json.fixture", import.meta.url), "utf8"),
  );
  pkg.agent.repository = "https://github.com/acme/provider";
  for (const binary of Object.values(pkg.agent.distribution.binary)) {
    binary.archive = "https://github.com/acme/provider/releases/download/v0.1.0/provider.tgz";
  }
  const submission = {
    schema_version: 1,
    package: pkg,
    source: { repository: pkg.agent.repository, commit, tag: "v0.1.0" },
    changelog: "preflight fixture",
  };
  await writeFile(path.join(state.root, "submission.json"), JSON.stringify(submission));
  const config = request({ publications: [{ submission: "submission.json" }], ...override });
  const bytes = Buffer.from(JSON.stringify(config));
  await writeFile(path.join(state.root, "request.json"), bytes);
  const remote = { count: 0 };
  const opts = options(state.root, state.privateKeyFile, bytes, clientCountingWrites(remote));
  const downloads = { count: 0 };
  opts.download = async () => {
    downloads.count += 1;
    throw new Error("unexpected source download");
  };
  return { ...state, submission, config, opts, remote, downloads };
}

async function rejectsBeforeNetwork(state, pattern) {
  await assert.rejects(runPublicationPipeline(state.opts), pattern);
  assert.equal(state.remote.count, 0);
  assert.equal(state.downloads.count, 0);
}

for (const [label, override, pattern] of [
  ["expired window", { expires_at: "2030-01-01T00:00:01Z" }, /expired/],
  ["noncanonical dates", { generated_at: "2030-01-01T00:00:00.000Z" }, /canonical UTC/],
  ["repository mismatch", { repository: "different/registry" }, /repository/],
  ["invalid baseline signature", { previous_index: "baseline.json" }, /envelope|signature/],
]) {
  test(`valid submissions cannot bypass ${label} preflight`, async (t) => {
    const state = await validFixture(t, override);
    if (override.previous_index) await writeFile(path.join(state.root, "baseline.json"), "{}");
    await rejectsBeforeNetwork(state, pattern);
    await assert.rejects(access(state.opts.directory), { code: "ENOENT" });
  });
}

test("mismatched signing key fails before downloads or remote writes", async (t) => {
  const state = await validFixture(t);
  const other = generateKeyPairSync("ed25519");
  await writeFile(state.privateKeyFile, other.privateKey.export({ type: "pkcs8", format: "pem" }));
  await rejectsBeforeNetwork(state, /does not match pinned public key/);
});

test("runtime-normalized identity collisions fail before downloading", async (t) => {
  const state = await validFixture(t);
  const second = structuredClone(state.submission);
  second.package.agent.id = "exampleprovider";
  second.package.agent.version = "0.2.0";
  await writeFile(path.join(state.root, "second.json"), JSON.stringify(second));
  state.config.publications.push({ submission: "second.json" });
  const bytes = Buffer.from(JSON.stringify(state.config));
  await writeFile(state.opts.requestFile, bytes);
  state.opts.confirmRequestSha256 = digest(bytes);
  await rejectsBeforeNetwork(state, /collid|normaliz/);
});

test("symlinked state child is rejected without changing the external directory", async (t) => {
  const state = await validFixture(t);
  const external = path.join(state.root, "external");
  await mkdir(external);
  await mkdir(state.opts.directory);
  await symlink(external, path.join(state.opts.directory, "inputs"));
  await rejectsBeforeNetwork(state, /symbolic link/);
  await assert.rejects(access(path.join(external, "public-key.pem")), { code: "ENOENT" });
});

test("a private key inside retained publication state is refused before network activity", async (t) => {
  const state = await validFixture(t);
  await mkdir(state.opts.directory);
  state.opts.privateKeyFile = path.join(state.opts.directory, "private.pem");
  const bytes = await readFile(state.privateKeyFile);
  await writeFile(state.opts.privateKeyFile, bytes);
  await rejectsBeforeNetwork(state, /private key must be outside/);
  assert.deepEqual(await readFile(state.opts.privateKeyFile), bytes);
  await assert.rejects(access(path.join(state.opts.directory, "pipeline-request.json")), {
    code: "ENOENT",
  });
});
