import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { validateReleaseAssets, verifyRemoteArtifact } from "./artifacts.mjs";
import { preparePublishedCatalog, readPublicationManifest } from "./catalog.mjs";
import { downloadVerifiedArchive } from "./download.mjs";
import {
  publishCanonicalReceipt,
  withOwnedLock,
  withOwnedTemporaryDirectory,
  writeExclusivePrivate,
} from "./files.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { prepareCatalogSnapshot } from "./snapshot.mjs";
import { validateSigningPayload } from "./signing.mjs";

const ASSET = "managed-index.json";
const LOCK = ".catalog.lock";
const RECEIPT = "catalog-publication-receipt.json";
const METADATA_LIMIT = 4 * 1024 * 1024;

async function prepareCatalogPublication(options) {
  const metadata = await lstat(options.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("catalog publication path must be a non-symlink directory");
  }
  const manifestFile = path.resolve(options.manifest);
  const manifest = await readPublicationManifest(manifestFile);
  if (manifest.repository !== options.repository) {
    throw new Error("publication manifest repository does not match --repository");
  }
  const snapshot = await prepareCatalogSnapshot(options);
  const expected = {
    name: ASSET,
    sha256: snapshot.sha256,
    size: snapshot.size,
    bytes: snapshot.bytes,
    expectedUrl: snapshot.expectedUrl,
  };
  const receipt = await readCatalogPublicationReceipt(options.directory, options, snapshot);
  const payload = await preparePublishedCatalog(manifest, {
    baseDirectory: path.dirname(manifestFile),
    generatedAt: snapshot.envelope.signed.generated_at,
    expiresAt: snapshot.envelope.signed.expires_at,
    download: options.download,
    now: options.now ?? new Date(),
  });
  if (canonicalJson(payload) !== canonicalJson(snapshot.envelope.signed)) {
    throw new Error("catalog payload does not exactly match the verified publication manifest");
  }
  // Archive verification can be slow. Freshness is an acceptance-time property,
  // so never reuse the snapshot preparation clock unless a test explicitly injects one.
  validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });
  return { manifest, snapshot, expected, receipt };
}

export async function publishCatalogSnapshot(options) {
  validateClient(options.client);
  if (typeof (options.download ?? downloadVerifiedArchive) !== "function") {
    throw new Error("catalog public download is invalid");
  }
  const metadata = await lstat(options.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("catalog publication path must be a non-symlink directory");
  }
  return withOwnedLock(path.join(options.directory, LOCK), "catalog directory", () =>
    prepareCatalogPublication(options).then((prepared) => publishLocked(options, prepared)),
  );
}

async function publishLocked(options, prepared) {
  const { client, registryCommit, directory } = options;
  const { snapshot, expected, receipt: priorReceipt } = prepared;
  await verifyTag(client, snapshot.tag, registryCommit, "before publication");
  let release = await resolveRelease(client, snapshot, registryCommit, priorReceipt, options.now);
  const boundReleaseId = release.id;
  let assets = validateReleaseAssets(await client.listAssets(release.id), [expected]);

  if (release.draft === false && !assets.has(ASSET)) {
    throw new Error("published catalog release is missing managed-index.json");
  }
  if (release.draft === true && !assets.has(ASSET)) {
    await revalidateRelease(client, release, snapshot, registryCommit, true);
    validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });
    await uploadCatalog(client, release.id, expected, directory);
  }
  assets = validateReleaseAssets(await client.listAssets(release.id), [expected], {
    requireComplete: true,
  });
  await verifyRemoteArtifact(client, assets.get(ASSET), expected, directory);

  if (release.draft === true) {
    const releaseId = release.id;
    release = await revalidateRelease(client, release, snapshot, registryCommit, true);
    await verifyTag(client, snapshot.tag, registryCommit, "before publication PATCH");
    validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });
    try {
      release = await client.publishDraft(releaseId);
    } catch (error) {
      const recovered = await client.findRelease(snapshot.tag);
      if (!matchesRelease(recovered, snapshot, registryCommit, releaseId, false)) throw error;
      release = recovered;
    }
  }
  validateRelease(release, snapshot, registryCommit, boundReleaseId, false);
  await verifyFinal(options, prepared, release);
  const receipt = buildReceipt(options, snapshot, release.id);
  if (priorReceipt) return priorReceipt;
  await publishCanonicalReceipt(directory, RECEIPT, receipt, METADATA_LIMIT, "catalog receipt");
  return receipt;
}

async function resolveRelease(client, snapshot, commit, receipt, now) {
  let release = await client.findRelease(snapshot.tag);
  if (!release) {
    if (receipt) throw new Error("catalog receipt refers to a missing release");
    validateSigningPayload(snapshot.envelope.signed, { now: now ?? new Date() });
    try {
      release = await client.createDraft({ tag: snapshot.tag, commit, body: snapshot.body });
    } catch (error) {
      const recovered = await client.findRelease(snapshot.tag);
      if (!recovered) throw error;
      release = recovered;
    }
  }
  validateRelease(release, snapshot, commit, receipt?.release_id, receipt ? false : undefined);
  return release;
}

async function uploadCatalog(client, releaseId, expected, directory) {
  return withOwnedTemporaryDirectory(directory, ".catalog-upload-", async (owned) => {
    const temporary = path.join(owned, ASSET);
    await writeExclusivePrivate(temporary, expected.bytes, "catalog upload");
    try {
      await client.uploadAsset({
        releaseId,
        name: expected.name,
        file: temporary,
        size: expected.size,
      });
    } catch (error) {
      const assets = validateReleaseAssets(await client.listAssets(releaseId), [expected]);
      const recovered = assets.get(expected.name);
      if (!recovered) throw error;
      await verifyRemoteArtifact(client, recovered, expected, directory);
    }
  });
}

async function verifyFinal(options, prepared, release) {
  const { client, registryCommit, directory } = options;
  const { snapshot, expected } = prepared;
  const current = await client.findRelease(snapshot.tag);
  validateRelease(current, snapshot, registryCommit, release.id, false);
  await verifyTag(client, snapshot.tag, registryCommit, "after publication");
  await withOwnedTemporaryDirectory(directory, ".catalog-public-", async (temporary) => {
    const result = await (options.download ?? downloadVerifiedArchive)({
      url: expected.expectedUrl,
      sha256: expected.sha256,
      outputPath: path.join(temporary, ASSET),
      maxBytes: expected.size,
    });
    if (result?.size !== expected.size) throw new Error("public catalog size does not match");
  });
  const final = await client.findRelease(snapshot.tag);
  validateRelease(final, snapshot, registryCommit, release.id, false);
  await verifyTag(client, snapshot.tag, registryCommit, "after public verification");
  validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });
}

export function validatePublishedCatalogRelease(release, snapshot, commit, expectedId) {
  validateRelease(release, snapshot, commit, expectedId, false);
}

function validateRelease(release, snapshot, commit, expectedId, expectedDraft) {
  if (!release) throw new Error("catalog release is missing");
  if (!Number.isSafeInteger(release.id) || release.id <= 0)
    throw new Error("release id is invalid");
  if (expectedId !== undefined && release.id !== expectedId) {
    throw new Error("catalog receipt release id conflicts with GitHub");
  }
  if (release.tag_name !== snapshot.tag) throw new Error("catalog release tag does not match");
  if (release.target_commitish !== commit) throw new Error("catalog release target does not match");
  if (release.body !== snapshot.body) throw new Error("catalog release body does not match");
  if (release.draft !== true && release.draft !== false)
    throw new Error("release draft state is invalid");
  if (expectedDraft !== undefined && release.draft !== expectedDraft) {
    throw new Error(
      expectedDraft
        ? "catalog release is unexpectedly published"
        : "catalog release is not published",
    );
  }
}

async function revalidateRelease(client, release, snapshot, commit, draft) {
  const current = await client.findRelease(snapshot.tag);
  validateRelease(current, snapshot, commit, release.id, draft);
  return current;
}

function matchesRelease(release, snapshot, commit, id, published) {
  try {
    validateRelease(release, snapshot, commit, id, published);
    return true;
  } catch {
    return false;
  }
}

async function verifyTag(client, tag, commit, timing) {
  if ((await client.getTagCommit(tag)) !== commit) {
    throw new Error(`catalog tag commit does not match ${timing}`);
  }
}

function buildReceipt(options, snapshot, releaseId) {
  return {
    schema_version: 1,
    status: "published_verified",
    repository: options.repository,
    registry_commit: options.registryCommit,
    release_id: releaseId,
    release_tag: snapshot.tag,
    tag_commit: options.registryCommit,
    catalog_sha256: snapshot.sha256,
    catalog_size: snapshot.size,
    catalog_url: snapshot.expectedUrl,
    previous_sha256: snapshot.previousSha256 ?? "bootstrap",
  };
}

export async function readCatalogPublicationReceipt(
  directory,
  options,
  snapshot,
  { required = false } = {},
) {
  const file = path.join(directory, RECEIPT);
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (error?.code === "ENOENT") throw new Error("catalog publication receipt is required");
    throw error;
  }
  let bytes;
  bytes = await readBoundedRegularFile(file, METADATA_LIMIT, "catalog receipt");
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing catalog receipt is invalid");
  }
  const expected = buildReceipt(options, snapshot, receipt?.release_id);
  if (
    !Number.isSafeInteger(receipt?.release_id) ||
    receipt.release_id <= 0 ||
    canonicalJson(receipt) !== canonicalJson(expected)
  ) {
    throw new Error("existing catalog receipt conflicts");
  }
  return receipt;
}

function validateClient(client) {
  for (const method of [
    "findRelease",
    "createDraft",
    "listAssets",
    "uploadAsset",
    "verifyAsset",
    "getTagCommit",
    "publishDraft",
  ]) {
    if (typeof client?.[method] !== "function")
      throw new Error(`catalog client is missing ${method}`);
  }
}
