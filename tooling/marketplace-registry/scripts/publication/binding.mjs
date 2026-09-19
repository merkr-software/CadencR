import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { readBoundedRegularFile } from "./io.mjs";

export const MAX_PUBLICATION_METADATA_BYTES = 4 * 1024 * 1024;
export const MIRROR_RECEIPT = "mirror-receipt.json";
export const PUBLICATION_RECEIPT = "publication-receipt.json";
export const PROVENANCE = "publication-plan.json";

export function buildPublicationBinding(staged, repository, registryCommit, directory) {
  const planBytes = Buffer.from(`${canonicalJson(staged.plan)}\n`);
  if (planBytes.length > MAX_PUBLICATION_METADATA_BYTES) {
    throw new Error("publication plan exceeds 4 MiB");
  }
  const planSha256 = sha256(planBytes.subarray(0, -1));
  const tag = staged.plan.release.tag;
  return {
    tag,
    planBytes,
    planSha256,
    body: releaseMarker(planSha256, registryCommit),
    expected: expectedArtifacts(staged, planBytes, directory, repository),
  };
}

export async function readMirrorReceipt(directory, binding, values, { required = false } = {}) {
  const file = path.join(directory, MIRROR_RECEIPT);
  try {
    await lstat(file);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readBoundedRegularFile(
    file,
    MAX_PUBLICATION_METADATA_BYTES,
    "mirror receipt",
  );
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing mirror receipt is invalid");
  }
  const valid =
    receipt?.schema_version === 1 &&
    receipt.status === "draft_verified" &&
    receipt.repository === values.repository &&
    receipt.registry_commit === values.registryCommit &&
    receipt.release_tag === binding.tag &&
    receipt.plan_sha256 === binding.planSha256 &&
    Number.isSafeInteger(receipt.release_id) &&
    receipt.release_id > 0 &&
    canonicalJson(receipt.artifacts) === canonicalJson(compactArtifacts(binding.expected));
  if (!valid) throw new Error("existing mirror receipt conflicts with publication");
  return receipt;
}

export function compactArtifacts(expected) {
  return expected.map(({ name, sha256: digest, size }) => ({ name, sha256: digest, size }));
}

export function buildPublicationReceipt(binding, repository, registryCommit, releaseId) {
  return {
    schema_version: 1,
    status: "published_verified",
    repository,
    registry_commit: registryCommit,
    release_id: releaseId,
    release_tag: binding.tag,
    tag_commit: registryCommit,
    plan_sha256: binding.planSha256,
    artifacts: compactArtifacts(binding.expected),
  };
}

export async function readPublicationReceipt(
  directory,
  binding,
  { repository, registryCommit, releaseId },
  { required = false } = {},
) {
  const file = path.join(directory, PUBLICATION_RECEIPT);
  try {
    await lstat(file);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readBoundedRegularFile(
    file,
    MAX_PUBLICATION_METADATA_BYTES,
    "publication receipt",
  );
  let actual;
  try {
    actual = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing publication receipt is invalid");
  }
  const expected = buildPublicationReceipt(binding, repository, registryCommit, releaseId);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("existing publication receipt conflicts");
  }
  return actual;
}

function releaseMarker(planSha256, commit) {
  return `cadencr-registry-mirror-v1\nplan-sha256:${planSha256}\nregistry-commit:${commit}`;
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
