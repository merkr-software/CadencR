import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { buildPublicationBinding, readMirrorReceipt, readPublicationReceipt } from "./binding.mjs";
import { isExactCommit } from "./commit.mjs";
import { downloadVerifiedArchive, MAX_ARCHIVE_BYTES } from "./download.mjs";
import { writeExclusivePrivate, withOwnedTemporaryDirectory } from "./files.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { createPublicationPlan, validPublicationRepository } from "./plan.mjs";
import { incrementalPayload, verifyBaseline } from "./incremental.mjs";
import { validateSigningKeyId } from "./signing.mjs";
import { hashRegularFile } from "./stage.mjs";

import { MAX_CATALOG_BYTES } from "./catalog-limits.mjs";
const MAX_CATALOG_REMOTE_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SUBMISSION_BYTES = 1024 * 1024;
const MAX_PUBLICATIONS = 100;

export async function readPublicationManifest(file) {
  const bytes = await readBoundedRegularFile(file, MAX_MANIFEST_BYTES, "publication manifest");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("publication manifest must be valid JSON");
  }
  validateManifest(value);
  return value;
}

export async function preparePublishedCatalog(
  manifest,
  { baseDirectory, generatedAt, expiresAt, download = downloadVerifiedArchive, now = new Date() },
) {
  validateManifest(manifest);
  if (typeof baseDirectory !== "string" || !path.isAbsolute(baseDirectory)) {
    throw new Error("manifest base directory must be absolute");
  }
  if (typeof download !== "function") throw new Error("catalog download is invalid");

  const prepared = [];
  const budget = { inputBytes: 0 };
  for (const [position, publication] of manifest.publications.entries()) {
    prepared.push(
      await prepareEntry(publication, position, manifest.repository, baseDirectory, budget),
    );
    validateResourceBudget(prepared.at(-1).binding.expected, {
      maxBytes: MAX_CATALOG_REMOTE_BYTES + 4 * 1024 * 1024,
    });
  }

  const baseline = manifest.baseline
    ? verifyBaseline(
        await readBoundedRegularFile(
          resolveInput(baseDirectory, manifest.baseline.previous_index),
          MAX_CATALOG_BYTES,
          "previous index",
        ),
        await readBoundedRegularFile(
          resolveInput(baseDirectory, manifest.baseline.public_key),
          16 * 1024,
          "public key",
        ),
        manifest.baseline.key_id,
        now,
      )
    : null;
  const payload = incrementalPayload({
    packages: prepared.map((entry) => entry.package),
    baseline,
    generatedAt,
    expiresAt,
    now,
  });
  if (Buffer.byteLength(canonicalJson(payload)) > MAX_CATALOG_BYTES)
    throw new Error("catalog payload exceeds 32 MiB");

  // All local receipts, the complete payload, its freshness window, and the
  // aggregate download budget are validated before the first network call.
  for (const { directory, binding } of prepared) {
    for (const artifact of binding.expected) {
      if (artifact.size > MAX_ARCHIVE_BYTES) throw new Error("public asset exceeds size limit");
      await withOwnedTemporaryDirectory(directory, ".catalog-public-", async (temporary) => {
        const outputPath = path.join(temporary, "asset");
        const result = await download({
          url: artifact.expectedUrl,
          sha256: artifact.sha256,
          outputPath,
          maxBytes: artifact.size,
        });
        if (result?.size !== artifact.size) throw new Error("public asset size does not match");
        const verified = await hashRegularFile(outputPath, artifact.size, "catalog public asset");
        if (verified.size !== artifact.size || verified.sha256 !== artifact.sha256)
          throw new Error("public asset bytes do not match the publication receipt");
      });
    }
  }
  return payload;
}

async function prepareEntry(publication, position, repository, baseDirectory, budget) {
  const submissionFile = resolveInput(baseDirectory, publication.submission);
  const directory = resolveInput(baseDirectory, publication.directory);
  const submissionBytes = await readBoundedRegularFile(
    submissionFile,
    MAX_SUBMISSION_BYTES,
    `submission ${position + 1}`,
  );
  budget.inputBytes += submissionBytes.length;
  if (budget.inputBytes > MAX_CATALOG_BYTES) throw new Error("catalog inputs exceed 32 MiB");
  let submission;
  try {
    submission = JSON.parse(submissionBytes.toString("utf8"));
  } catch {
    throw new Error(`submission ${position + 1} must be valid JSON`);
  }
  const plan = createPublicationPlan(submission, repository);
  const bytes = await readBoundedRegularFile(
    path.join(directory, "staging-receipt.json"),
    4 * 1024 * 1024,
    "staging receipt",
  );
  let staged;
  try {
    staged = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing staging receipt is invalid");
  }
  if (
    staged?.schema_version !== 1 ||
    canonicalJson(staged.plan) !== canonicalJson(plan) ||
    !Array.isArray(staged.artifacts) ||
    staged.artifacts.length !== plan.targets.length
  )
    throw new Error("staging receipt conflicts with publication plan");
  for (const [index, target] of plan.targets.entries()) {
    const artifact = staged.artifacts[index];
    if (
      artifact?.asset !== target.asset ||
      artifact.sha256 !== target.sha256 ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      artifact.size > MAX_ARCHIVE_BYTES
    )
      throw new Error("staging receipt archive conflicts with publication plan");
  }
  const registryCommit = publication.registry_commit;
  const binding = buildPublicationBinding(staged, repository, registryCommit, directory);
  const mirror = await readMirrorReceipt(
    directory,
    binding,
    { repository, registryCommit },
    { required: true },
  );
  await readPublicationReceipt(
    directory,
    binding,
    { repository, registryCommit, releaseId: mirror.release_id },
    { required: true },
  );
  return { directory, binding, package: staged.plan.mirrored_package };
}

export function validateResourceBudget(artifacts, { maxBytes = MAX_CATALOG_REMOTE_BYTES } = {}) {
  const total = artifacts.reduce((sum, artifact) => {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
      throw new Error("publication receipt contains an invalid asset size");
    }
    return sum + artifact.size;
  }, 0);
  if (!Number.isSafeInteger(total) || total > maxBytes) {
    throw new Error("catalog public assets exceed the aggregate size limit");
  }
  return total;
}

export async function writeCatalogExclusively(file, envelope) {
  const parent = path.dirname(path.resolve(file));
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("output directory must be a non-symlink directory");
  }
  const bytes = Buffer.from(`${canonicalJson(envelope)}\n`);
  await writeExclusivePrivate(file, bytes, "catalog output");
}

function validateManifest(value) {
  if (!isObject(value)) throw new Error("publication manifest must be an object");
  rejectKeys(
    value,
    new Set(["schema_version", "repository", "publications", "baseline"]),
    "manifest",
  );
  if (value.schema_version !== 1) throw new Error("manifest.schema_version must equal 1");
  if (!validPublicationRepository(value.repository))
    throw new Error("manifest.repository is invalid");
  if (
    !Array.isArray(value.publications) ||
    (value.publications.length === 0 && value.baseline === undefined) ||
    value.publications.length > MAX_PUBLICATIONS
  ) {
    throw new Error("manifest.publications must contain between 1 and 100 entries");
  }
  if (value.baseline !== undefined) {
    if (!isObject(value.baseline)) throw new Error("manifest.baseline must be an object");
    rejectKeys(
      value.baseline,
      new Set(["previous_index", "public_key", "key_id"]),
      "manifest.baseline",
    );
    for (const field of ["previous_index", "public_key"])
      if (
        typeof value.baseline[field] !== "string" ||
        !value.baseline[field] ||
        value.baseline[field].includes("\0")
      )
        throw new Error(`manifest.baseline.${field} must be a non-empty path`);
    validateSigningKeyId(value.baseline.key_id);
  }
  value.publications.forEach((entry, position) => {
    const label = `manifest.publications[${position}]`;
    if (!isObject(entry)) throw new Error(`${label} must be an object`);
    rejectKeys(entry, new Set(["submission", "directory", "registry_commit"]), label);
    for (const field of ["submission", "directory"])
      if (typeof entry[field] !== "string" || !entry[field] || entry[field].includes("\0")) {
        throw new Error(`${label}.${field} must be a non-empty path`);
      }
    if (!isExactCommit(entry.registry_commit)) {
      throw new Error(`${label}.registry_commit must be 40 lowercase hex characters`);
    }
  });
}

function resolveInput(base, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function rejectKeys(value, allowed, label) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
