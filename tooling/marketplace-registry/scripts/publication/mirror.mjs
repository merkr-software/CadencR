import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdtemp, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { isExactCommit } from "./commit.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { cleanupFailure, withOwnedLock } from "./files.mjs";
import { stagePublication } from "./stage.mjs";

const LOCK = ".mirror.lock";
const RECEIPT = "mirror-receipt.json";
const PROVENANCE = "publication-plan.json";
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;

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
  const planBytes = Buffer.from(`${canonicalJson(staged.plan)}\n`);
  if (planBytes.length > MAX_PROVENANCE_BYTES) throw new Error("publication plan exceeds 4 MiB");
  const planSha256 = sha256(planBytes.subarray(0, -1));
  const body = releaseMarker(planSha256, registryCommit);
  const expected = expectedArtifacts(staged, planBytes, directory, repository);
  const priorReceipt = await readExistingReceipt(directory, {
    repository,
    registryCommit,
    tag: staged.plan.release.tag,
    planSha256,
    expected,
  });
  const release = await resolveRelease(
    client,
    staged.plan.release.tag,
    registryCommit,
    body,
    priorReceipt,
  );
  let assets = validateAssets(await client.listAssets(release.id), expected);
  await verifyPresent(client, assets, expected, directory);
  for (const artifact of expected.filter(({ name }) => !assets.has(name))) {
    await revalidateRelease(client, release, registryCommit, body);
    await uploadOne(client, release.id, artifact, expected, directory);
    assets = validateAssets(await client.listAssets(release.id), expected);
  }
  assets = validateAssets(await client.listAssets(release.id), expected);
  if (assets.size !== expected.length) throw new Error("release is missing expected assets");
  await verifyPresent(client, assets, expected, directory);
  await revalidateRelease(client, release, registryCommit, body);
  const receipt = {
    schema_version: 1,
    status: "draft_verified",
    repository,
    registry_commit: registryCommit,
    release_id: release.id,
    release_tag: staged.plan.release.tag,
    plan_sha256: planSha256,
    artifacts: expected.map(({ name, sha256, size }) => ({ name, sha256, size })),
  };
  await publishReceipt(directory, receipt);
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

function releaseMarker(planSha256, commit) {
  return `cadencr-registry-mirror-v1\nplan-sha256:${planSha256}\nregistry-commit:${commit}`;
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

function expectedArtifacts(staged, planBytes, directory, repository) {
  return [
    ...staged.artifacts.map((artifact) => ({
      name: artifact.asset,
      sha256: artifact.sha256,
      size: artifact.size,
      file: path.join(directory, artifact.asset),
      expectedUrl: staged.plan.targets.find(({ asset }) => asset === artifact.asset)
        .destination_url,
    })),
    {
      name: PROVENANCE,
      sha256: sha256(planBytes),
      size: planBytes.length,
      bytes: planBytes,
      expectedUrl: `https://github.com/${repository}/releases/download/${staged.plan.release.tag}/${PROVENANCE}`,
    },
  ];
}

function validateAssets(list, expected) {
  if (!Array.isArray(list)) throw new Error("release asset listing is invalid");
  const allowed = new Set(expected.map(({ name }) => name));
  const assets = new Map();
  for (const asset of list) {
    if (!asset || typeof asset.name !== "string" || !allowed.has(asset.name)) {
      throw new Error("release contains an unexpected asset");
    }
    if (assets.has(asset.name)) throw new Error(`duplicate release asset: ${asset.name}`);
    if (asset.state !== "uploaded") {
      throw new Error(`release asset is not uploaded: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  return assets;
}

async function uploadOne(client, releaseId, artifact, expected, directory) {
  let temporary;
  let primaryError;
  try {
    const file = artifact.file ?? (temporary = await writeTemporary(directory, artifact.bytes));
    await client.uploadAsset({ releaseId, name: artifact.name, file, size: artifact.size });
  } catch (error) {
    primaryError = error;
    const assets = validateAssets(await client.listAssets(releaseId), expected);
    const recovered = assets.get(artifact.name);
    if (!recovered) throw error;
    await verifyRemote(client, recovered, artifact, directory);
  } finally {
    if (temporary)
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw cleanupFailure(primaryError, [error]);
      });
  }
}

async function verifyPresent(client, assets, expected, directory) {
  for (const artifact of expected) {
    const asset = assets.get(artifact.name);
    if (asset) await verifyRemote(client, asset, artifact, directory);
  }
}

async function verifyRemote(client, asset, artifact, directory) {
  const temporaryDirectory = await mkdtemp(path.join(directory, ".mirror-verify-"));
  const outputPath = path.join(temporaryDirectory, "asset");
  let primaryError;
  try {
    await client.verifyAsset({
      asset,
      expectedUrl: artifact.expectedUrl,
      sha256: artifact.sha256,
      size: artifact.size,
      outputPath,
    });
  } catch (error) {
    primaryError = error;
  }
  const failures = [];
  await rm(temporaryDirectory, { recursive: true }).catch((error) => failures.push(error));
  if (failures.length) throw cleanupFailure(primaryError, failures);
  if (primaryError) throw primaryError;
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

async function readExistingReceipt(directory, values) {
  const file = path.join(directory, RECEIPT);
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readBoundedRegularFile(file, MAX_PROVENANCE_BYTES, "mirror receipt");
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing mirror receipt is invalid");
  }
  const artifacts = values.expected.map(({ name, sha256, size }) => ({ name, sha256, size }));
  const valid =
    receipt?.schema_version === 1 &&
    receipt.status === "draft_verified" &&
    receipt.repository === values.repository &&
    receipt.registry_commit === values.registryCommit &&
    receipt.release_tag === values.tag &&
    receipt.plan_sha256 === values.planSha256 &&
    Number.isSafeInteger(receipt.release_id) &&
    receipt.release_id > 0 &&
    canonicalJson(receipt.artifacts) === canonicalJson(artifacts);
  if (!valid) throw new Error("existing mirror receipt conflicts with publication");
  return receipt;
}

async function publishReceipt(directory, receipt) {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  const destination = path.join(directory, RECEIPT);
  const temporary = await writeTemporary(directory, bytes);
  let primary;
  try {
    await link(temporary, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") primary = error;
    else {
      try {
        const existing = await readBoundedRegularFile(
          destination,
          MAX_PROVENANCE_BYTES,
          "mirror receipt",
        );
        if (!existing.equals(bytes)) primary = new Error("existing mirror receipt conflicts");
      } catch (readError) {
        primary = readError;
      }
    }
  }
  const failures = [];
  await unlink(temporary).catch((error) => failures.push(error));
  if (failures.length) throw cleanupFailure(primary, failures);
  if (primary) throw primary;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
