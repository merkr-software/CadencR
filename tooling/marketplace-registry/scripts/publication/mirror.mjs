import { randomBytes } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import {
  validateReleaseAssets,
  verifyRemoteArtifact,
  verifyRemoteArtifacts,
} from "./artifacts.mjs";
import {
  buildPublicationBinding,
  compactArtifacts,
  MAX_PUBLICATION_METADATA_BYTES,
  MIRROR_RECEIPT,
  readMirrorReceipt,
} from "./binding.mjs";
import { isExactCommit } from "./commit.mjs";
import { cleanupFailure, publishCanonicalReceipt, withOwnedLock } from "./files.mjs";
import { stagePublication } from "./stage.mjs";

const LOCK = ".mirror.lock";

export async function mirrorPublication({
  submission,
  repository,
  registryCommit,
  directory,
  client,
}) {
  validateInputs(registryCommit, client);
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error("mirror path must be a non-symlink directory");
  }
  const lockPath = path.join(directory, LOCK);
  return withOwnedLock(lockPath, "mirror directory", () =>
    mirrorLocked({ submission, repository, registryCommit, directory, client }),
  );
}

async function mirrorLocked(options) {
  const { submission, repository, registryCommit, directory, client } = options;
  const staged = await stagePublication(submission, repository, directory, {
    download: async () => {
      throw new Error("publication is not fully staged; mirror refuses to download sources");
    },
  });
  const binding = buildPublicationBinding(staged, repository, registryCommit, directory);
  const { tag, planSha256, body, expected } = binding;
  const priorReceipt = await readMirrorReceipt(directory, binding, {
    repository,
    registryCommit,
  });
  const release = await resolveRelease(client, tag, registryCommit, body, priorReceipt);
  let assets = validateReleaseAssets(await client.listAssets(release.id), expected);
  await verifyRemoteArtifacts(client, assets, expected, directory);
  for (const artifact of expected.filter(({ name }) => !assets.has(name))) {
    await revalidateRelease(client, release, registryCommit, body);
    await uploadOne(client, release.id, artifact, expected, directory);
    assets = validateReleaseAssets(await client.listAssets(release.id), expected);
  }
  assets = validateReleaseAssets(await client.listAssets(release.id), expected, {
    requireComplete: true,
  });
  await verifyRemoteArtifacts(client, assets, expected, directory);
  await revalidateRelease(client, release, registryCommit, body);
  const receipt = {
    schema_version: 1,
    status: "draft_verified",
    repository,
    registry_commit: registryCommit,
    release_id: release.id,
    release_tag: tag,
    plan_sha256: planSha256,
    artifacts: compactArtifacts(expected),
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

function validateInputs(commit, client) {
  if (!isExactCommit(commit))
    throw new Error("registry commit must be 40 lowercase hex characters");
  for (const method of ["findRelease", "createDraft", "listAssets", "uploadAsset", "verifyAsset"]) {
    if (typeof client?.[method] !== "function")
      throw new Error(`mirror client is missing ${method}`);
  }
}

async function resolveRelease(client, tag, commit, body, priorReceipt) {
  let release = await client.findRelease(tag);
  if (!release) {
    if (priorReceipt) throw new Error("mirror receipt refers to a missing release");
    try {
      release = await client.createDraft({ tag, commit, body });
    } catch (error) {
      const recovered = await client.findRelease(tag);
      if (!recovered) throw error;
      release = recovered;
    }
  }
  validateRelease(release, tag, commit, body);
  if (priorReceipt && priorReceipt.release_id !== release.id) {
    throw new Error("mirror receipt release id conflicts with GitHub");
  }
  return release;
}

function validateRelease(release, tag, commit, body) {
  if (release?.draft !== true) throw new Error("refusing non-draft or published release");
  if (release.tag_name !== tag) throw new Error("release tag does not match publication plan");
  if (release.target_commitish !== commit) throw new Error("release target commit does not match");
  if (release.body !== body) throw new Error("release body does not match immutable binding");
  if (!Number.isSafeInteger(release.id) || release.id <= 0)
    throw new Error("release id is invalid");
}

async function revalidateRelease(client, release, commit, body) {
  const current = await client.findRelease(release.tag_name);
  if (!current) throw new Error("draft release disappeared during mirroring");
  validateRelease(current, release.tag_name, commit, body);
  if (current.id !== release.id) throw new Error("draft release identity changed during mirroring");
}

async function uploadOne(client, releaseId, artifact, expected, directory) {
  let temporary;
  let primaryError;
  try {
    const file = artifact.file ?? (temporary = await writeTemporary(directory, artifact.bytes));
    await client.uploadAsset({ releaseId, name: artifact.name, file, size: artifact.size });
  } catch (error) {
    primaryError = error;
    const assets = validateReleaseAssets(await client.listAssets(releaseId), expected);
    const recovered = assets.get(artifact.name);
    if (!recovered) throw error;
    await verifyRemoteArtifact(client, recovered, artifact, directory);
  } finally {
    if (temporary)
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw cleanupFailure(primaryError, [error]);
      });
  }
}

async function writeTemporary(directory, bytes) {
  const file = path.join(directory, `.mirror-${randomBytes(12).toString("hex")}.part`);
  const handle = await open(file, "wx", 0o600);
  let primary;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    primary = error;
  }
  const failures = [];
  await handle.close().catch((error) => failures.push(error));
  if (primary || failures.length) {
    await unlink(file).catch((error) => failures.push(error));
    if (failures.length) throw cleanupFailure(primary, failures);
    throw primary;
  }
  return file;
}
