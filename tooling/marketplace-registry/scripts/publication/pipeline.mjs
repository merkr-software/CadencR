import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { preflightCatalog } from "./pipeline-preflight.mjs";
import { signPublicationCatalog } from "../sign-publication-catalog.mjs";
import { buildPublicationBinding, readMirrorReceipt } from "./binding.mjs";
import { preparePublishedCatalog } from "./catalog.mjs";
import { isExactCommit } from "./commit.mjs";
import { advanceCatalogDiscovery } from "./discovery.mjs";
import { validateDiscoveryBranch } from "./discovery-location.mjs";
import { withOwnedLock } from "./files.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { mirrorPublication } from "./mirror.mjs";
import { createPublicationPlan, validPublicationRepository } from "./plan.mjs";
import {
  bindRequest,
  ensureStateDirectory,
  materializeInputs,
  writeCanonicalOnce,
} from "./pipeline-state.mjs";
import { promotePublication } from "./promote.mjs";
import { publishCatalogSnapshot } from "./publish-catalog.mjs";
import { prepareCatalogSnapshot } from "./snapshot.mjs";
import { stagePipelinePublications } from "./pipeline-staging.mjs";
import { validateSigningKeyId } from "./signing.mjs";

const REQUEST_LIMIT = 1024 * 1024;
const SUBMISSIONS_LIMIT = 32 * 1024 * 1024;
const MANIFEST = "publication-manifest.json";
const CATALOG = "managed-index.json";

export async function runPublicationPipeline(options) {
  validateOptions(options);
  const prepared = await prepareRequest(options);
  preflightCatalog(options, prepared, prepared.entries);
  await ensureStateDirectory(options.directory);
  return withOwnedLock(path.join(options.directory, ".pipeline.lock"), "publication pipeline", () =>
    runLocked(options, prepared),
  );
}

async function runLocked(options, prepared) {
  await bindRequest(options.directory, prepared.binding);
  await materializeInputs(options.directory, prepared);
  const staged = await stagePipelinePublications(options, prepared.entries);
  const manifestFile = path.join(options.directory, MANIFEST);
  const manifest = buildManifest(options, prepared);
  await writeCanonicalOnce(manifestFile, manifest, "publication manifest");
  const catalogFile = path.join(options.directory, CATALOG);
  await preflightCatalog(options, prepared, staged);

  for (const [index, entry] of prepared.entries.entries()) {
    const commit = entry.registryCommit;
    const binding = buildPublicationBinding(
      staged[index],
      options.repository,
      commit,
      entry.directory,
    );
    await options.client.ensurePublicationTag({ tag: binding.tag, commit });
    const receipt = await readMirrorReceipt(entry.directory, binding, {
      repository: options.repository,
      registryCommit: commit,
    });
    if (!receipt) {
      await mirrorPublication({
        submission: entry.submission,
        repository: options.repository,
        registryCommit: commit,
        directory: entry.directory,
        client: options.client,
      });
    }
    await promotePublication({
      submission: entry.submission,
      repository: options.repository,
      registryCommit: commit,
      directory: entry.directory,
      client: options.client,
      download: options.download,
    });
  }

  await prepareCandidate(options, prepared.request, manifest, manifestFile, catalogFile);
  const catalogOptions = catalogOperationOptions(
    options,
    prepared.request,
    manifestFile,
    catalogFile,
  );
  const snapshot = await prepareCatalogSnapshot(catalogOptions);
  await options.client.ensurePublicationTag({ tag: snapshot.tag, commit: options.registryCommit });
  const catalogReceipt = await publishCatalogSnapshot(catalogOptions);
  const discoveryReceipt = await advanceCatalogDiscovery({
    ...catalogOptions,
    discoveryBranch: prepared.request.discovery_branch,
    downloadDiscovery: options.downloadDiscovery,
  });
  return { catalog: catalogReceipt, discovery: discoveryReceipt };
}

async function prepareRequest(options) {
  const requestFile = path.resolve(options.requestFile);
  const bytes = await readBoundedRegularFile(requestFile, REQUEST_LIMIT, "publication request");
  const digest = sha256(bytes);
  if (digest !== options.confirmRequestSha256)
    throw new Error("publication request SHA-256 confirmation does not match");
  let request;
  try {
    request = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("publication request must be valid JSON");
  }
  validateRequest(request, options);
  const base = path.dirname(requestFile);
  const publicKey = await trustedFile(base, request.public_key, 16 * 1024, "public key");
  const previous =
    request.previous_index === "bootstrap"
      ? null
      : await trustedFile(base, request.previous_index, REQUEST_LIMIT, "previous index");
  const entries = [];
  let total = 0;
  for (const [index, publication] of request.publications.entries()) {
    const input = await trustedFile(
      base,
      publication.submission,
      REQUEST_LIMIT,
      `submission ${index + 1}`,
    );
    total += input.bytes.length;
    if (total > SUBMISSIONS_LIMIT) throw new Error("submission inputs exceed 32 MiB");
    let submission;
    try {
      submission = JSON.parse(input.bytes.toString("utf8"));
    } catch {
      throw new Error(`submission ${index + 1} must be valid JSON`);
    }
    const plan = createPublicationPlan(submission, options.repository);
    entries.push({
      plan,
      submission,
      bytes: input.bytes,
      registryCommit: publication.registry_commit ?? options.registryCommit,
      directory: path.join(options.directory, "publications", String(index + 1).padStart(3, "0")),
    });
  }
  await validatePrivateKeyLocation(options.privateKeyFile, options.directory);
  await validateKeyPair(options.privateKeyFile, publicKey.bytes);
  return {
    request,
    entries,
    publicKey,
    previous,
    binding: {
      schema_version: 1,
      request_sha256: digest,
      repository: options.repository,
      registry_commit: options.registryCommit,
      request,
    },
  };
}

async function validatePrivateKeyLocation(privateKeyFile, stateDirectory) {
  const key = await realpath(privateKeyFile);
  const state = path.resolve(stateDirectory);
  if (key === state || key.startsWith(`${state}${path.sep}`)) {
    throw new Error("private key must be outside the pipeline state directory");
  }
}

function validateRequest(request, options) {
  if (!isObject(request)) throw new Error("publication request must be an object");
  rejectKeys(
    request,
    new Set([
      "schema_version",
      "repository",
      "key_id",
      "discovery_branch",
      "generated_at",
      "expires_at",
      "previous_index",
      "public_key",
      "publications",
    ]),
    "request",
  );
  if (request.schema_version !== 1) throw new Error("request.schema_version must equal 1");
  if (!validPublicationRepository(request.repository) || request.repository !== options.repository)
    throw new Error("request repository does not match repository");
  for (const field of ["key_id", "discovery_branch", "generated_at", "expires_at"])
    if (typeof request[field] !== "string" || !request[field])
      throw new Error(`request.${field} is invalid`);
  if (request.previous_index !== "bootstrap")
    validateRelative(request.previous_index, "request.previous_index");
  validateRelative(request.public_key, "request.public_key");
  if (
    !Array.isArray(request.publications) ||
    request.publications.length < 1 ||
    request.publications.length > 100
  )
    throw new Error("request.publications must contain between 1 and 100 entries");
  request.publications.forEach((entry, index) => {
    if (!isObject(entry)) throw new Error(`request.publications[${index}] must be an object`);
    rejectKeys(entry, new Set(["submission", "registry_commit"]), `request.publications[${index}]`);
    validateRelative(entry.submission, `request.publications[${index}].submission`);
    if (entry.registry_commit !== undefined && !isExactCommit(entry.registry_commit))
      throw new Error(`request.publications[${index}].registry_commit is invalid`);
  });
  if (!isExactCommit(options.registryCommit))
    throw new Error("registryCommit must be 40 lowercase hex characters");
  validateDiscoveryBranch(request.discovery_branch);
  validateSigningKeyId(request.key_id);
}

async function trustedFile(base, relative, limit, label) {
  validateRelative(relative, label);
  const root = path.resolve(base);
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("request parent must be a non-symlink directory");
  }
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`))
    throw new Error(`${label} escapes request directory`);
  let cursor = root;
  for (const segment of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
  }
  return { bytes: await readBoundedRegularFile(file, limit, label), relative };
}

async function validateKeyPair(privateKeyFile, publicBytes) {
  const privateBytes = await readBoundedRegularFile(privateKeyFile, 16 * 1024, "private key");
  let derived;
  let pinned;
  try {
    const privateKey = createPrivateKey(privateBytes);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error();
    derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const publicKey = createPublicKey(publicBytes);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error();
    pinned = publicKey.export({ type: "spki", format: "der" });
  } catch {
    throw new Error("publication signing keys must be valid Ed25519 keys");
  }
  if (!derived.equals(pinned)) throw new Error("private key does not match pinned public key");
}

function buildManifest(options, prepared) {
  return {
    schema_version: 1,
    repository: options.repository,
    publications: prepared.entries.map((entry, index) => ({
      submission: `publications/${String(index + 1).padStart(3, "0")}/submission.json`,
      directory: `publications/${String(index + 1).padStart(3, "0")}`,
      registry_commit: entry.registryCommit,
    })),
  };
}

async function prepareCandidate(options, request, manifest, manifestFile, catalogFile) {
  const snapshotOptions = catalogOperationOptions(options, request, manifestFile, catalogFile);
  try {
    await lstat(catalogFile);
    const snapshot = await prepareCatalogSnapshot(snapshotOptions);
    const payload = await preparePublishedCatalog(manifest, {
      baseDirectory: options.directory,
      generatedAt: request.generated_at,
      expiresAt: request.expires_at,
      download: options.download,
      now: options.now ?? new Date(),
    });
    if (canonicalJson(snapshot.envelope.signed) !== canonicalJson(payload))
      throw new Error("existing signed catalog conflicts with reconstructed payload");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await signPublicationCatalog({
      manifest: manifestFile,
      generatedAt: request.generated_at,
      expiresAt: request.expires_at,
      privateKey: options.privateKeyFile,
      keyId: request.key_id,
      output: catalogFile,
      download: options.download,
      now: options.now,
    });
    await prepareCatalogSnapshot(snapshotOptions);
  }
}

function catalogOperationOptions(options, request, manifest, catalogFile) {
  return {
    directory: options.directory,
    manifest,
    catalogFile,
    previousIndex:
      request.previous_index === "bootstrap"
        ? "bootstrap"
        : path.join(options.directory, "inputs", "previous-index.json"),
    publicKeyFile: path.join(options.directory, "inputs", "public-key.pem"),
    keyId: request.key_id,
    repository: options.repository,
    registryCommit: options.registryCommit,
    client: options.client,
    download: options.download,
    now: options.now,
  };
}

function validateOptions(options) {
  for (const field of [
    "requestFile",
    "directory",
    "repository",
    "registryCommit",
    "privateKeyFile",
    "confirmRequestSha256",
  ])
    if (typeof options?.[field] !== "string" || !options[field])
      throw new Error(`${field} is required`);
  if (!/^[a-f0-9]{64}$/.test(options.confirmRequestSha256))
    throw new Error("confirmRequestSha256 must be 64 lowercase hex characters");
  for (const method of [
    "ensurePublicationTag",
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
    if (typeof options.client?.[method] !== "function") {
      throw new Error(`publication client is missing ${method}`);
    }
  }
}
function validateRelative(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split(/[\\/]/).includes("..")
  )
    throw new Error(`${label} must be a safe relative path`);
}
function rejectKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
