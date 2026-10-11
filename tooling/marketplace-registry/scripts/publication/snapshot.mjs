import { createHash, createPublicKey } from "node:crypto";
import { canonicalJson } from "../lib.mjs";
import { providerIdentifierKey } from "../submission.mjs";
import { isExactCommit } from "./commit.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { validPublicationRepository } from "./plan.mjs";
import { validateSigningKeyId, verifyIndexEnvelope } from "./signing.mjs";

const CATALOG_LIMIT = 1024 * 1024;
const KEY_LIMIT = 16 * 1024;

export async function prepareCatalogSnapshot({
  catalogFile,
  previousIndex,
  publicKeyFile,
  keyId,
  repository,
  registryCommit,
  now = new Date(),
}) {
  if (!validPublicationRepository(repository)) throw new Error("repository is invalid");
  if (!isExactCommit(registryCommit))
    throw new Error("registryCommit must be 40 lowercase hex characters");
  validateSigningKeyId(keyId);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now is invalid");

  const keyBytes = await readBoundedRegularFile(publicKeyFile, KEY_LIMIT, "public key");
  const publicKey = parsePublicKey(keyBytes);
  const candidateBytes = await readBoundedRegularFile(catalogFile, CATALOG_LIMIT, "catalog");
  const envelope = parseJson(candidateBytes, "catalog");
  verifyIndexEnvelope(envelope, { publicKey, keyId, now });

  let previousSha256;
  if (previousIndex !== "bootstrap") {
    if (typeof previousIndex !== "string" || previousIndex.length === 0) {
      throw new Error("previousIndex must be bootstrap or a file path");
    }
    const baselineInput = await readBoundedRegularFile(
      previousIndex,
      CATALOG_LIMIT,
      "previous index",
    );
    const baseline = parseJson(baselineInput, "previous index");
    verifyIndexEnvelope(baseline, { publicKey, keyId, now, allowExpired: true });
    validateCatalogContinuity(baseline.signed, envelope.signed);
    // Bind the exact previously published asset, not a reserialization of it.
    previousSha256 = digest(baselineInput);
  }

  validateCatalogIdentities(envelope.signed.packages);
  const bytes = canonicalEnvelopeBytes(envelope);
  if (bytes.length > CATALOG_LIMIT) throw new Error("catalog snapshot exceeds 1 MiB");
  const sha256 = digest(bytes);
  const tag = `catalog-${sha256}`;
  const body = [
    "cadencr-registry-catalog-v1",
    `catalog-sha256:${sha256}`,
    `registry-commit:${registryCommit}`,
    `previous-sha256:${previousSha256 ?? "bootstrap"}`,
  ].join("\n");
  return {
    envelope,
    bytes,
    sha256,
    size: bytes.length,
    tag,
    body,
    expectedUrl: `https://github.com/${repository}/releases/download/${tag}/managed-index.json`,
    previousSha256,
  };
}

export function validateCatalogContinuity(previous, candidate) {
  if (Date.parse(candidate.generated_at) <= Date.parse(previous.generated_at)) {
    throw new Error("catalog generated_at must strictly increase");
  }
  const next = new Map(
    candidate.packages.map((entry) => [`${entry.agent.id}@${entry.agent.version}`, entry]),
  );
  for (const prior of previous.packages) {
    const identity = `${prior.agent.id}@${prior.agent.version}`;
    const current = next.get(identity);
    if (!current) throw new Error(`catalog removes previous package ${identity}`);
    if (canonicalJson(current) !== canonicalJson(prior)) {
      throw new Error(`catalog mutates previous package ${identity}`);
    }
  }
  const owners = ownerMap(previous.packages);
  for (const entry of candidate.packages) {
    const priorOwner = owners.get(entry.agent.id);
    const owner = ownerKey(entry);
    if (priorOwner !== undefined && priorOwner !== owner) {
      throw new Error(`provider ${entry.agent.id} changes publisher or source ownership`);
    }
  }
}

export function validateCatalogIdentities(packages, { ownership = "source" } = {}) {
  validateNormalizedIdentities(packages);
  ownerMap(packages, ownership);
}

function validateNormalizedIdentities(packages) {
  const normalized = new Map();
  for (const entry of packages) {
    const id = entry.agent.id;
    const key = providerIdentifierKey(id);
    const prior = normalized.get(key);
    if (prior !== undefined && prior !== id) {
      throw new Error(`provider id ${id} collides with ${prior} after runtime normalization`);
    }
    normalized.set(key, id);
  }
}

function ownerMap(packages, ownership = "source") {
  if (ownership !== "source" && ownership !== "repository")
    throw new Error("catalog ownership label is invalid");
  const owners = new Map();
  for (const entry of packages) {
    const owner = ownerKey(entry);
    const prior = owners.get(entry.agent.id);
    if (prior !== undefined && prior !== owner) {
      throw new Error(
        `provider ${entry.agent.id} has conflicting publisher or ${ownership} ownership`,
      );
    }
    owners.set(entry.agent.id, owner);
  }
  return owners;
}

function ownerKey(entry) {
  return `${entry.host.publisher}\0${entry.agent.repository ?? ""}`;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function parsePublicKey(bytes) {
  const pem = bytes.toString("utf8");
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(pem)) {
    throw new Error("public key must be an Ed25519 SPKI PEM file");
  }
  try {
    const key = createPublicKey({ key: pem, format: "pem", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("public key must be an Ed25519 SPKI PEM file");
  }
}

function canonicalEnvelopeBytes(envelope) {
  return Buffer.from(`${canonicalJson(envelope)}\n`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
