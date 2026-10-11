import { lstat } from "node:fs/promises";
import path from "node:path";
import { validateReleaseAssets, verifyRemoteArtifacts } from "./artifacts.mjs";
import {
  buildPublicationBinding,
  buildPublicationReceipt,
  MAX_PUBLICATION_METADATA_BYTES,
  PUBLICATION_RECEIPT,
  readMirrorReceipt,
  readPublicationReceipt,
} from "./binding.mjs";
import { isExactCommit } from "./commit.mjs";
import { downloadVerifiedArchive, MAX_ARCHIVE_BYTES } from "./download.mjs";
import { publishCanonicalReceipt, withOwnedLock, withOwnedTemporaryDirectory } from "./files.mjs";
import { stagePublication } from "./stage.mjs";

const LOCK = ".mirror.lock";

export async function promotePublication({
  submission,
  repository,
  registryCommit,
  directory,
  client,
  download = downloadVerifiedArchive,
  requirePublished = false,
}) {
  validateInputs(registryCommit, client, download, requirePublished);
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("promotion path must be a non-symlink directory");
  }
  return withOwnedLock(path.join(directory, LOCK), "mirror directory", () =>
    promoteLocked({
      submission,
      repository,
      registryCommit,
      directory,
      client,
      download,
      requirePublished,
    }),
  );
}

async function promoteLocked(options) {
  const binding = await prepareBinding(options);
  const { client, registryCommit, repository, directory, download, requirePublished } = options;
  let release = await client.findRelease(binding.tag);
  validateBoundRelease(release, binding, registryCommit);
  const assets = validateReleaseAssets(await client.listAssets(release.id), binding.expected, {
    requireComplete: true,
  });
  await verifyRemoteArtifacts(client, assets, binding.expected, directory);
  await verifyTag(client, binding.tag, registryCommit, "before publication");

  if (release.draft === true) {
    if (
      requirePublished ||
      binding.receipt.status === "published_recovered" ||
      binding.publicationReceipt !== null
    ) {
      throw new Error("historically published release is unexpectedly draft");
    }
    release = await revalidateBeforePatch(client, binding, registryCommit, release.id);
    try {
      release = await client.publishDraft(release.id);
    } catch (error) {
      const recovered = await client.findRelease(binding.tag);
      if (!isPublishedMatch(recovered, binding, registryCommit, release.id)) throw error;
      release = recovered;
    }
  }
  validatePublishedRelease(release, binding, registryCommit);
  const current = await client.findRelease(binding.tag);
  validatePublishedRelease(current, binding, registryCommit, binding.receipt.release_id);
  await verifyTag(client, binding.tag, registryCommit, "after publication");
  await verifyPublicArtifacts(binding.expected, directory, download);
  const final = await client.findRelease(binding.tag);
  validatePublishedRelease(final, binding, registryCommit, binding.receipt.release_id);
  await verifyTag(client, binding.tag, registryCommit, "after public verification");

  const receipt = publicationReceipt(binding, repository, registryCommit);
  await publishCanonicalReceipt(
    directory,
    PUBLICATION_RECEIPT,
    receipt,
    MAX_PUBLICATION_METADATA_BYTES,
    "publication receipt",
  );
  return receipt;
}

async function prepareBinding(options) {
  const { submission, repository, registryCommit, directory } = options;
  const staged = await stagePublication(submission, repository, directory, {
    download: async () => {
      throw new Error("publication is not fully staged; promotion refuses to download sources");
    },
  });
  const binding = buildPublicationBinding(staged, repository, registryCommit, directory);
  const receipt = await readMirrorReceipt(
    directory,
    binding,
    {
      repository,
      registryCommit,
    },
    { required: true },
  );
  const publicationReceipt = await readPublicationReceipt(directory, binding, {
    repository,
    registryCommit,
    releaseId: receipt.release_id,
  });
  return { ...binding, receipt, publicationReceipt };
}

function validateInputs(commit, client, download, requirePublished) {
  if (!isExactCommit(commit))
    throw new Error("registry commit must be 40 lowercase hex characters");
  for (const method of [
    "findRelease",
    "listAssets",
    "verifyAsset",
    "getTagCommit",
    "publishDraft",
  ]) {
    if (typeof client?.[method] !== "function")
      throw new Error(`promotion client is missing ${method}`);
  }
  if (typeof download !== "function") throw new Error("promotion download is invalid");
  if (typeof requirePublished !== "boolean") {
    throw new Error("promotion requirePublished must be boolean");
  }
}

function validateBoundRelease(release, binding, commit, expectedId = binding.receipt.release_id) {
  if (!release) throw new Error("mirror receipt refers to a missing release");
  if (release.draft !== true && release.draft !== false)
    throw new Error("release draft state is invalid");
  if (release.id !== expectedId) throw new Error("mirror receipt release id conflicts with GitHub");
  if (release.tag_name !== binding.tag)
    throw new Error("release tag does not match publication plan");
  if (release.target_commitish !== commit) throw new Error("release target commit does not match");
  if (release.body !== binding.body)
    throw new Error("release body does not match immutable binding");
}

export function validatePublishedRelease(release, binding, commit, expectedId) {
  validateBoundRelease(release, binding, commit, expectedId);
  if (release.draft !== false) throw new Error("release is not published");
}

function isPublishedMatch(release, binding, commit, id) {
  try {
    validatePublishedRelease(release, binding, commit, id);
    return true;
  } catch {
    return false;
  }
}

async function revalidateBeforePatch(client, binding, commit, id) {
  const current = await client.findRelease(binding.tag);
  validateBoundRelease(current, binding, commit, id);
  if (current.draft !== true) throw new Error("release changed before publication");
  return current;
}

export async function verifyTag(client, tag, commit, timing) {
  const actual = await client.getTagCommit(tag);
  if (actual !== commit) throw new Error(`release tag commit does not match ${timing}`);
}

export async function verifyPublicArtifacts(expected, directory, download) {
  for (const artifact of expected) {
    if (artifact.size > MAX_ARCHIVE_BYTES) throw new Error("public asset exceeds size limit");
    await withOwnedTemporaryDirectory(directory, ".promote-public-", async (temporary) => {
      const result = await download({
        url: artifact.expectedUrl,
        sha256: artifact.sha256,
        outputPath: path.join(temporary, "asset"),
        maxBytes: artifact.size,
      });
      if (result?.size !== artifact.size) throw new Error("public asset size does not match");
    });
  }
}

function publicationReceipt(binding, repository, registryCommit) {
  return buildPublicationReceipt(binding, repository, registryCommit, binding.receipt.release_id);
}
