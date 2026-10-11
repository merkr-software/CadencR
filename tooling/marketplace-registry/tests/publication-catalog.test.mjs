import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPublicationBinding,
  buildPublicationReceipt,
  compactArtifacts,
} from "../scripts/publication/binding.mjs";
import {
  preparePublishedCatalog,
  validateResourceBudget,
} from "../scripts/publication/catalog.mjs";
import { stagePublication } from "../scripts/publication/stage.mjs";
import { signPublicationCatalog } from "../scripts/sign-publication-catalog.mjs";
import { signIndexPayload } from "../scripts/publication/signing.mjs";
import { incrementalPayload, verifyBaseline } from "../scripts/publication/incremental.mjs";

test("signed 120-version history renews without archives or downloads", async (t) => {
  const state = await fixture(t);
  const initial = await prepare(state);
  const keys = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(state.root, "private.pem");
  await writeFile(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(
    path.join(state.root, "public.pem"),
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const packages = Array.from({ length: 120 }, (_, patch) => {
    const entry = structuredClone(initial.packages[0]);
    entry.agent.version = `1.0.${patch}`;
    entry.agent.description = "x".repeat(10_000);
    return entry;
  });
  const envelope = await signIndexPayload(
    { ...initial, packages },
    { privateKeyFile, keyId: "test-key", now },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024);
  await writeFile(path.join(state.root, "previous.json"), JSON.stringify(envelope));
  state.manifest.baseline = {
    previous_index: "previous.json",
    public_key: "public.pem",
    key_id: "test-key",
  };
  state.manifest.publications = [];
  let calls = 0;
  const renewed = await prepare(state, {
    generatedAt: "2026-09-19T10:00:01Z",
    download: async () => {
      calls += 1;
      throw new Error("unexpected download");
    },
  });
  assert.equal(renewed.packages.length, 120);
  assert.deepEqual(renewed.packages, packages);
  assert.equal(calls, 0);
  const manifestFile = path.join(state.root, "renewal-manifest.json");
  await writeFile(manifestFile, JSON.stringify(state.manifest));
  const otherPrivate = path.join(state.root, "other-private.pem");
  await writeFile(
    otherPrivate,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await assert.rejects(
    signPublicationCatalog({
      manifest: manifestFile,
      generatedAt: "2026-09-19T10:00:01Z",
      expiresAt,
      privateKey: otherPrivate,
      keyId: "test-key",
      output: path.join(state.root, "not-signed.json"),
      now,
    }),
    /pinned baseline public key/,
  );
  const baseline = verifyBaseline(
    Buffer.from(JSON.stringify(envelope)),
    await readFile(path.join(state.root, "public.pem")),
    "test-key",
    now,
  );
  const next = structuredClone(initial.packages[0]);
  next.agent.version = "2.0.0";
  const grown = incrementalPayload({
    packages: [next],
    baseline,
    generatedAt: "2026-09-19T10:00:01Z",
    expiresAt,
    now,
  });
  assert.equal(grown.packages.length, 121);
  assert.deepEqual(grown.packages.slice(0, 120), packages);
  const mutated = structuredClone(packages[0]);
  mutated.agent.name = "mutated";
  assert.throws(
    () =>
      incrementalPayload({
        packages: [mutated],
        baseline,
        generatedAt: "2026-09-19T10:00:01Z",
        expiresAt,
        now,
      }),
    /mutates immutable/,
  );
  envelope.signed.packages[0].agent.name = "tampered";
  await writeFile(path.join(state.root, "previous.json"), JSON.stringify(envelope));
  await assert.rejects(prepare(state), /signature/);
});

const repository = "cadencr/registry";
const commit = "b".repeat(40);
const archive = Buffer.from("published archive");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const generatedAt = "2026-09-19T10:00:00Z";
const expiresAt = "2026-09-20T10:00:00Z";
const now = new Date("2026-09-19T10:00:01Z");

function submission(id = "acme-agent", version = "1.0.0", publisher = "acme") {
  const source = `https://github.com/${publisher}/${id}`;
  return {
    schema_version: 1,
    package: {
      agent: {
        id,
        name: id,
        version,
        description: "Agent",
        license: "MIT",
        repository: source,
        distribution: {
          binary: {
            "linux-x86_64": {
              archive: `${source}/releases/download/v1/provider.tgz`,
              cmd: "bin/provider",
              sha256: digest(archive),
            },
          },
        },
      },
      host: {
        publisher,
        compatibility: { min_app_version: "0.12.0" },
        assets: { icon: "icon.svg", readme: "README.md", license: "LICENSE" },
      },
    },
    source: { repository: source, commit: "a".repeat(40), tag: "v1" },
    changelog: "Release",
  };
}

async function fixture(t, specs = [{}]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publications = [];
  const publicBytes = new Map();
  for (const [index, spec] of specs.entries()) {
    const value = submission(spec.id, spec.version, spec.publisher);
    if (spec.emptyAuthors) value.package.agent.authors = [];
    const submissionFile = path.join(root, `submission-${index}.json`);
    const directory = path.join(root, `stage-${index}`);
    await writeFile(submissionFile, JSON.stringify(value));
    const staged = await stagePublication(value, repository, directory, {
      download: async ({ outputPath }) => writeFile(outputPath, archive, { flag: "wx" }),
    });
    const binding = buildPublicationBinding(staged, repository, commit, directory);
    const releaseId = index + 1;
    const mirror = {
      schema_version: 1,
      status: "draft_verified",
      repository,
      registry_commit: commit,
      release_id: releaseId,
      release_tag: binding.tag,
      plan_sha256: binding.planSha256,
      artifacts: compactArtifacts(binding.expected),
    };
    await writeFile(path.join(directory, "mirror-receipt.json"), JSON.stringify(mirror));
    await writeFile(
      path.join(directory, "publication-receipt.json"),
      JSON.stringify(buildPublicationReceipt(binding, repository, commit, releaseId)),
    );
    for (const artifact of binding.expected) {
      publicBytes.set(artifact.expectedUrl, artifact.bytes ?? archive);
    }
    publications.push({
      submission: path.relative(root, submissionFile),
      directory: path.relative(root, directory),
      registry_commit: commit,
    });
  }
  const manifest = { schema_version: 1, repository, publications };
  const download = async ({ url, sha256, outputPath }) => {
    const bytes = publicBytes.get(url);
    if (!bytes) throw new Error("public asset unavailable");
    assert.equal(digest(bytes), sha256);
    await writeFile(outputPath, bytes, { flag: "wx" });
    return { size: bytes.length, sha256 };
  };
  return { root, manifest, download };
}

const prepare = (state, overrides = {}) =>
  preparePublishedCatalog(state.manifest, {
    baseDirectory: state.root,
    generatedAt,
    expiresAt,
    download: state.download,
    now,
    ...overrides,
  });

test("builds a deterministic catalog only from exact published receipts", async (t) => {
  const state = await fixture(t, [{ id: "zeta-agent" }, { id: "acme-agent" }]);
  const payload = await prepare(state);
  assert.deepEqual(
    payload.packages.map(({ agent }) => agent.id),
    ["acme-agent", "zeta-agent"],
  );
});

test("rejects missing and forged publication receipts before network access", async (t) => {
  for (const forged of [null, { forged: true }]) {
    const state = await fixture(t);
    const receipt = path.join(state.root, "stage-0", "publication-receipt.json");
    if (forged === null) await rm(receipt);
    else await writeFile(receipt, JSON.stringify(forged));
    let calls = 0;
    await assert.rejects(
      prepare(state, { download: async () => calls++ }),
      /publication receipt|ENOENT/,
    );
    assert.equal(calls, 0);
  }
});

test("ignores transient staged bytes but rejects unavailable public bytes", async (t) => {
  const changed = await fixture(t);
  const stagedName = await readFile(
    path.join(changed.root, "stage-0", "staging-receipt.json"),
    "utf8",
  );
  const asset = JSON.parse(stagedName).artifacts[0].asset;
  await writeFile(path.join(changed.root, "stage-0", asset), "forged");
  await prepare(changed);
  await rm(path.join(changed.root, "stage-0", asset));
  await prepare(changed);

  const unavailable = await fixture(t);
  await assert.rejects(
    prepare(unavailable, {
      download: async () => {
        throw new Error("public unavailable");
      },
    }),
    /public unavailable/,
  );
});

test("rejects duplicates, ownership collisions, and invalid catalog dates before downloads", async (t) => {
  for (const [specs, pattern] of [
    [[{}, {}], /duplicate id@version/],
    [[{}, { version: "2.0.0", publisher: "other" }], /conflicting publisher/],
  ]) {
    const state = await fixture(t, specs);
    let calls = 0;
    await assert.rejects(prepare(state, { download: async () => calls++ }), pattern);
    assert.equal(calls, 0);
  }
  const state = await fixture(t);
  await assert.rejects(
    prepare(state, { generatedAt: "not-a-date", download: async () => assert.fail() }),
    /generated_at/,
  );
});

test("refuses an existing output before reading inputs or invoking the signer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-catalog-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "catalog.json");
  await writeFile(output, "operator-owned");
  let signed = false;
  await assert.rejects(
    signPublicationCatalog({
      manifest: path.join(root, "missing.json"),
      generatedAt,
      expiresAt,
      privateKey: path.join(root, "missing.pem"),
      keyId: "test",
      output,
      sign: async () => {
        signed = true;
      },
    }),
    /output already exists/,
  );
  assert.equal(signed, false);
  assert.equal(await readFile(output, "utf8"), "operator-owned");
});

test("rejects an invalid signing key id before catalog downloads", async (t) => {
  const state = await fixture(t);
  const manifest = path.join(state.root, "manifest.json");
  const output = path.join(state.root, "catalog.json");
  await writeFile(manifest, JSON.stringify(state.manifest));
  let calls = 0;
  await assert.rejects(
    signPublicationCatalog({
      manifest,
      generatedAt,
      expiresAt,
      privateKey: path.join(state.root, "missing-private.pem"),
      keyId: "invalid key id",
      output,
      download: async () => calls++,
      now,
    }),
    /signing key id is invalid/,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(output), { code: "ENOENT" });
});

test("strict manifest boundaries fail before filesystem or network work", async () => {
  const publication = { submission: "missing", directory: "missing", registry_commit: commit };
  for (const [manifest, pattern] of [
    [{ schema_version: 1, repository, publications: [publication], extra: true }, /extra/],
    [
      {
        schema_version: 1,
        repository,
        publications: Array.from({ length: 101 }, () => publication),
      },
      /between 1 and 100/,
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      preparePublishedCatalog(manifest, {
        baseDirectory: "/does-not-exist",
        generatedAt,
        expiresAt,
        download: async () => calls++,
        now,
      }),
      pattern,
    );
    assert.equal(calls, 0);
  }
});

test("rejects normalized provider collisions and empty optional fields before downloads", async (t) => {
  const collision = await fixture(t, [{ id: "acmeagent" }, { id: "acme-agent" }]);
  let calls = 0;
  await assert.rejects(prepare(collision, { download: async () => calls++ }), /normalization/);
  assert.equal(calls, 0);

  const optional = await fixture(t, [{ emptyAuthors: true }]);
  await assert.rejects(
    prepare(optional, { download: async () => calls++ }),
    /empty optional field/,
  );
  assert.equal(calls, 0);
});

test("enforces aggregate public byte budget without performing I/O", () => {
  assert.equal(validateResourceBudget([{ size: 2 }, { size: 3 }], { maxBytes: 5 }), 5);
  assert.throws(
    () => validateResourceBudget([{ size: 2 }, { size: 4 }], { maxBytes: 5 }),
    /aggregate size limit/,
  );
  assert.throws(() => validateResourceBudget([{ size: -1 }]), /invalid asset size/);
});

test("default CLI flow does not pin the pre-download clock for signing", async (t) => {
  const state = await fixture(t);
  const manifest = path.join(state.root, "manifest.json");
  const output = path.join(state.root, "catalog.json");
  await writeFile(manifest, JSON.stringify(state.manifest));
  let signingOptions;
  const timestamp = Math.floor(Date.now() / 1000) * 1000;
  const utcSecond = (value) => new Date(value).toISOString().replace(".000Z", "Z");
  await signPublicationCatalog({
    manifest,
    generatedAt: utcSecond(timestamp - 60_000),
    expiresAt: utcSecond(timestamp + 86_400_000),
    privateKey: "unused-test-key",
    keyId: "test-key",
    output,
    download: state.download,
    sign: async (payload, options) => {
      signingOptions = options;
      return {
        signed: payload,
        signature: { algorithm: "ed25519", key_id: "test-key", value: "test-only" },
      };
    },
  });
  assert.equal(Object.hasOwn(signingOptions, "now"), false);
});
