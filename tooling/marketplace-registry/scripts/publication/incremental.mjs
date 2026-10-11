import { MAX_CATALOG_BYTES } from "./catalog-limits.mjs";
import { createPublicKey } from "node:crypto";
import { canonicalJson, comparePackages } from "../lib.mjs";
import { validateCatalogContinuity, validateCatalogIdentities } from "./snapshot.mjs";
import { validateSigningPayload, verifyIndexEnvelope } from "./signing.mjs";

export function verifyBaseline(bytes, publicBytes, keyId, now) {
  if (bytes.length > MAX_CATALOG_BYTES || publicBytes.length > 16 * 1024)
    throw new Error("publication baseline or key exceeds input limits");
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("previous index must be valid JSON");
  }
  verifyIndexEnvelope(envelope, {
    publicKey: createPublicKey(publicBytes),
    keyId,
    now,
    allowExpired: true,
  });
  validateCatalogIdentities(envelope.signed.packages);
  return envelope.signed;
}

export function incrementalPayload({ packages, baseline, generatedAt, expiresAt, now }) {
  const merged = new Map((baseline?.packages ?? []).map((entry) => [identity(entry), entry]));
  const seen = new Set();
  for (const entry of packages) {
    const key = identity(entry);
    if (seen.has(key)) throw new Error(`duplicate id@version in delta ${key}`);
    seen.add(key);
    if (merged.has(key) && canonicalJson(merged.get(key)) !== canonicalJson(entry))
      throw new Error(`candidate mutates immutable package ${key}`);
    merged.set(key, entry);
  }
  const payload = {
    schema_version: 1,
    generated_at: generatedAt,
    expires_at: expiresAt,
    packages: [...merged.values()].sort(comparePackages),
  };
  validateSigningPayload(payload, { now });
  validateCatalogIdentities(payload.packages);
  if (baseline) validateCatalogContinuity(baseline, payload);
  return payload;
}

function identity(entry) {
  return `${entry.agent.id}@${entry.agent.version}`;
}
