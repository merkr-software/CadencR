import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { preparePublishedCatalog, readPublicationManifest } from "./catalog.mjs";
import { downloadVerifiedArchive, downloadVerifiedDiscovery } from "./download.mjs";
import { publishCanonicalReceipt, withOwnedLock, withOwnedTemporaryDirectory } from "./files.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import {
  readCatalogPublicationReceipt,
  validatePublishedCatalogRelease,
} from "./publish-catalog.mjs";
import { prepareCatalogSnapshot } from "./snapshot.mjs";
import { validateSigningPayload } from "./signing.mjs";
import { discoveryUrl, validateDiscoveryBranch } from "./discovery-location.mjs";

const LOCK = ".catalog.lock";
const RECEIPT = "discovery-receipt.json";
const LIMIT = 4 * 1024 * 1024;

export async function advanceCatalogDiscovery(options) {
  validateClient(options.client);
  validateDiscoveryBranch(options.discoveryBranch);
  const metadata = await lstat(options.directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("catalog publication path must be a non-symlink directory");
  }
  await rejectSymbolicLock(path.join(options.directory, LOCK));
  return withOwnedLock(path.join(options.directory, LOCK), "catalog directory", () =>
    advanceLocked(options),
  );
}

async function advanceLocked(options) {
  const snapshot = await prepareCatalogSnapshot(options);
  const catalogReceipt = await readCatalogPublicationReceipt(options.directory, options, snapshot, {
    required: true,
  });
  const priorReceipt = await readDiscoveryReceipt(options.directory);
  validatePriorReceiptBinding(priorReceipt, options, snapshot, catalogReceipt.release_id);
  const original = normalizeDiscovery(await options.client.getDiscovery(options.discoveryBranch));
  const replay = assessHead(original, snapshot);

  const release = await options.client.findRelease(snapshot.tag);
  validatePublishedCatalogRelease(
    release,
    snapshot,
    options.registryCommit,
    catalogReceipt.release_id,
  );
  if ((await options.client.getTagCommit(snapshot.tag)) !== options.registryCommit) {
    throw new Error("catalog tag commit does not match before discovery advancement");
  }
  await verifyPublishedCatalog(options, snapshot);
  await verifyManifestPayload(options, snapshot);
  const immediatelyCurrent = normalizeDiscovery(
    await options.client.getDiscovery(options.discoveryBranch),
  );
  requireSameHead(original, immediatelyCurrent);
  validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });

  let finalHead = immediatelyCurrent;
  if (!replay) {
    try {
      await options.client.setDiscovery({
        branch: options.discoveryBranch,
        bytes: snapshot.bytes,
        expectedSha: original?.sha ?? null,
      });
      finalHead = normalizeDiscovery(await options.client.getDiscovery(options.discoveryBranch));
    } catch (error) {
      const winner = normalizeDiscovery(await options.client.getDiscovery(options.discoveryBranch));
      if (!isCandidate(winner, snapshot)) throw error;
      finalHead = winner;
    }
  }

  requireCandidate(finalHead, snapshot);
  await verifyRawDiscovery(options, snapshot);
  const afterRaw = normalizeDiscovery(await options.client.getDiscovery(options.discoveryBranch));
  requireCandidate(afterRaw, snapshot);
  if (afterRaw.sha !== finalHead.sha)
    throw new Error("discovery changed during public verification");
  validateSigningPayload(snapshot.envelope.signed, { now: options.now ?? new Date() });

  const receipt = buildDiscoveryReceipt(options, snapshot, release, afterRaw.sha);
  validatePriorReceipt(priorReceipt, receipt);
  if (!priorReceipt) {
    await publishCanonicalReceipt(options.directory, RECEIPT, receipt, LIMIT, "discovery receipt");
  }
  return priorReceipt ?? receipt;
}

async function verifyPublishedCatalog(options, snapshot) {
  await withOwnedTemporaryDirectory(options.directory, ".discovery-catalog-", async (temporary) => {
    const result = await (options.download ?? downloadVerifiedArchive)({
      url: snapshot.expectedUrl,
      sha256: snapshot.sha256,
      outputPath: path.join(temporary, "managed-index.json"),
      maxBytes: snapshot.size,
    });
    if (result?.size !== snapshot.size) throw new Error("public catalog size does not match");
  });
}

async function verifyManifestPayload(options, snapshot) {
  const manifestFile = path.resolve(options.manifest);
  const manifest = await readPublicationManifest(manifestFile);
  if (manifest.repository !== options.repository) {
    throw new Error("publication manifest repository does not match --repository");
  }
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
}

async function verifyRawDiscovery(options, snapshot) {
  await withOwnedTemporaryDirectory(options.directory, ".discovery-public-", async (temporary) => {
    const result = await (options.downloadDiscovery ?? downloadVerifiedDiscovery)({
      url: discoveryUrl(options.repository, options.discoveryBranch),
      sha256: snapshot.sha256,
      outputPath: path.join(temporary, "managed-index.json"),
      maxBytes: snapshot.size,
    });
    if (result?.size !== snapshot.size) throw new Error("public discovery size does not match");
  });
}

function assessHead(head, snapshot) {
  if (isCandidate(head, snapshot)) return true;
  if (snapshot.previousSha256 === undefined) {
    if (head !== null) throw new Error("discovery is not absent for bootstrap");
    return false;
  }
  if (head === null || canonicalDigest(head.bytes) !== snapshot.previousSha256) {
    throw new Error("discovery does not match the signed baseline");
  }
  return false;
}

function canonicalDigest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("discovery contains invalid JSON");
  }
  return digest(Buffer.from(`${canonicalJson(value)}\n`));
}

function normalizeDiscovery(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !Buffer.isBuffer(value.bytes)) {
    throw new Error("discovery response is malformed");
  }
  if (typeof value.sha !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)) {
    throw new Error("discovery blob SHA is invalid");
  }
  return value;
}

function requireSameHead(expected, actual) {
  if (expected === null && actual === null) return;
  if (
    expected === null ||
    actual === null ||
    expected.sha !== actual.sha ||
    !expected.bytes.equals(actual.bytes)
  ) {
    throw new Error("discovery changed before advancement");
  }
}

function isCandidate(head, snapshot) {
  return head !== null && head.bytes.equals(snapshot.bytes);
}

function requireCandidate(head, snapshot) {
  if (!isCandidate(head, snapshot)) throw new Error("discovery does not contain the candidate");
}

function buildDiscoveryReceipt(options, snapshot, release, blobSha) {
  return {
    schema_version: 1,
    status: "discovery_verified",
    repository: options.repository,
    branch: options.discoveryBranch,
    url: discoveryUrl(options.repository, options.discoveryBranch),
    snapshot_sha256: snapshot.sha256,
    baseline_sha256: snapshot.previousSha256 ?? "bootstrap",
    blob_sha: blobSha,
    release_id: release.id,
    release_tag: snapshot.tag,
    registry_commit: options.registryCommit,
    tag_commit: options.registryCommit,
  };
}

async function readDiscoveryReceipt(directory) {
  const file = path.join(directory, RECEIPT);
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readBoundedRegularFile(file, LIMIT, "discovery receipt");
  try {
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("invalid shape");
    }
    return receipt;
  } catch {
    throw new Error("existing discovery receipt is invalid");
  }
}

function validatePriorReceipt(actual, expected) {
  if (actual && canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("existing discovery receipt conflicts");
  }
}

function validatePriorReceiptBinding(actual, options, snapshot, releaseId) {
  if (!actual) return;
  const expected = buildDiscoveryReceipt(options, snapshot, { id: releaseId }, actual.blob_sha);
  if (
    typeof actual.blob_sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(actual.blob_sha) ||
    canonicalJson(actual) !== canonicalJson(expected)
  ) {
    throw new Error("existing discovery receipt conflicts");
  }
}

async function rejectSymbolicLock(file) {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) throw new Error("catalog lock must not be a symbolic link");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateClient(client) {
  for (const method of ["findRelease", "getTagCommit", "getDiscovery", "setDiscovery"]) {
    if (typeof client?.[method] !== "function") {
      throw new Error(`discovery client is missing ${method}`);
    }
  }
}
