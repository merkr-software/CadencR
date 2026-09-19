import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { validateReleaseAssets, verifyRemoteArtifacts } from "./artifacts.mjs";
import {
  buildPublicationBinding,
  compactArtifacts,
  MAX_PUBLICATION_METADATA_BYTES,
  MIRROR_RECEIPT,
  PUBLICATION_RECEIPT,
  readMirrorReceipt,
  readPublicationReceipt,
} from "./binding.mjs";
import { isExactCommit } from "./commit.mjs";
import { downloadVerifiedArchive } from "./download.mjs";
import { publishCanonicalReceipt, withOwnedLock } from "./files.mjs";
import { validatePublishedRelease, verifyPublicArtifacts, verifyTag } from "./promote.mjs";
import { stagePublication } from "./stage.mjs";

const LOCK = ".mirror.lock";

export async function recoverPublishedMirror({
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
    throw new Error("recovery path must be a non-symlink directory");
  }
  return withOwnedLock(path.join(directory, LOCK), "mirror directory", () =>
    recoverLocked({
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

async function recoverLocked(options) {
  const { submission, repository, registryCommit, directory, client, download, requirePublished } =
    options;
  const staged = await stagePublication(submission, repository, directory, {
    download: async () => {
      throw new Error("publication is not fully staged; recovery refuses to download sources");
    },
  });
  const binding = buildPublicationBinding(staged, repository, registryCommit, directory);
  const existing = await readMirrorReceipt(directory, binding, { repository, registryCommit });
  let publicationReceipt = null;
  if (existing) {
    publicationReceipt = await readPublicationReceipt(directory, binding, {
      repository,
      registryCommit,
      releaseId: existing.release_id,
    });
    if (!requirePublished && existing.status === "draft_verified" && publicationReceipt === null) {
      return existing;
    }
  }

  const release = await client.findRelease(binding.tag);
  if (!release || release.draft === true) {
    if (requirePublished) {
      throw new Error("published release is required but missing or draft");
    }
    if (
      existing?.status === "published_recovered" ||
      publicationReceipt !== null ||
      (await fileExists(path.join(directory, PUBLICATION_RECEIPT)))
    ) {
      throw new Error("existing publication receipt conflicts with a missing or draft release");
    }
    return null;
  }
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error("release id is invalid");
  }
  validatePublishedRelease(release, binding, registryCommit, existing?.release_id ?? release.id);
  if (!existing) {
    publicationReceipt = await readPublicationReceipt(directory, binding, {
      repository,
      registryCommit,
      releaseId: release.id,
    });
  }

  const assets = validateReleaseAssets(await client.listAssets(release.id), binding.expected, {
    requireComplete: true,
  });
  await verifyRemoteArtifacts(client, assets, binding.expected, directory);
  await verifyTag(client, binding.tag, registryCommit, "before recovery verification");
  await verifyPublicArtifacts(binding.expected, directory, download);

  const finalAssets = validateReleaseAssets(await client.listAssets(release.id), binding.expected, {
    requireComplete: true,
  });
  requireSameAssets(assets, finalAssets, binding.expected);
  await verifyRemoteArtifacts(client, finalAssets, binding.expected, directory);

  const final = await client.findRelease(binding.tag);
  validatePublishedRelease(final, binding, registryCommit, release.id);
  await verifyTag(client, binding.tag, registryCommit, "after recovery verification");

  if (existing) return existing;
  const receipt = {
    schema_version: 1,
    status: "published_recovered",
    repository,
    registry_commit: registryCommit,
    release_id: release.id,
    release_tag: binding.tag,
    plan_sha256: binding.planSha256,
    artifacts: compactArtifacts(binding.expected),
  };
  await publishCanonicalReceipt(
    directory,
    MIRROR_RECEIPT,
    receipt,
    MAX_PUBLICATION_METADATA_BYTES,
    "mirror receipt",
  );
  return receipt;
}

function requireSameAssets(before, after, expected) {
  const snapshot = (assets) =>
    expected.map(({ name }) => {
      const { id, size, state, browser_download_url: url, digest } = assets.get(name);
      return { name, id, size, state, url, digest: digest ?? null };
    });
  if (canonicalJson(snapshot(before)) !== canonicalJson(snapshot(after))) {
    throw new Error("release assets changed during public verification");
  }
}

async function fileExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateInputs(commit, client, download, requirePublished) {
  if (!isExactCommit(commit)) {
    throw new Error("registry commit must be 40 lowercase hex characters");
  }
  for (const method of ["findRelease", "listAssets", "verifyAsset", "getTagCommit"]) {
    if (typeof client?.[method] !== "function") {
      throw new Error(`recovery client is missing ${method}`);
    }
  }
  if (typeof download !== "function") throw new Error("recovery download is invalid");
  if (typeof requirePublished !== "boolean") {
    throw new Error("recovery requirePublished must be boolean");
  }
}
