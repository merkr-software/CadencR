import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson, validateIndex, validateSignedIndex, validIdentifier } from "../lib.mjs";
import { readBoundedRegularFile } from "./io.mjs";

const KEY_LIMIT = 16 * 1024;
const CANONICAL_UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateSigningPayload(signed, { now = new Date() } = {}) {
  validateCanonicalTimestamps(signed);
  validateCanonicalOptionalFields(signed);
  const errors = validateIndex(signed, { now });
  if (errors.length) throw new Error(`payload validation failed:\n${errors.join("\n")}`);
  return signed;
}

export function validateSigningKeyId(keyId) {
  if (!validIdentifier(keyId)) throw new Error("signing key id is invalid");
  return keyId;
}

export async function signIndexPayload(signed, { privateKeyFile, keyId, now = new Date() } = {}) {
  validateSigningPayload(signed, { now });
  validateSigningKeyId(keyId);
  const keyBytes = await readBoundedRegularFile(privateKeyFile, KEY_LIMIT, "private key");
  const privateKey = parsePrivateKey(keyBytes);
  const payload = Buffer.from(canonicalJson(signed));
  const signatureBytes = sign(null, payload, privateKey);
  if (!verify(null, payload, createPublicKey(privateKey), signatureBytes)) {
    throw new Error("signature self-verification failed");
  }
  const envelope = {
    signed,
    signature: {
      algorithm: "ed25519",
      key_id: keyId,
      value: signatureBytes.toString("base64"),
    },
  };
  validateEnvelope(envelope, { now });
  return envelope;
}

function validateEnvelope(envelope, { now }) {
  const errors = validateSignedIndex(envelope, { now });
  if (errors.length) throw new Error(`envelope validation failed:\n${errors.join("\n")}`);
}

function validateCanonicalTimestamps(signed) {
  for (const field of ["generated_at", "expires_at"]) {
    const value = signed?.[field];
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (
      typeof value === "string" &&
      (!CANONICAL_UTC_SECOND.test(value) ||
        !Number.isFinite(parsed) ||
        new Date(parsed).toISOString().replace(".000Z", "Z") !== value)
    ) {
      throw new Error(
        `payload.${field} must use canonical UTC whole-second form YYYY-MM-DDTHH:mm:ssZ`,
      );
    }
  }
}

function validateCanonicalOptionalFields(signed) {
  if (!Array.isArray(signed?.packages)) return;
  signed.packages.forEach((entry, packageIndex) => {
    const agent = entry?.agent;
    rejectEmpty(agent, "authors", `payload.packages[${packageIndex}].agent.authors`);
    const distribution = agent?.distribution;
    const binary = distribution?.binary;
    if (binary !== null && typeof binary === "object" && !Array.isArray(binary)) {
      for (const [targetName, target] of Object.entries(binary)) {
        const prefix = `payload.packages[${packageIndex}].agent.distribution.binary.${targetName}`;
        rejectEmpty(target, "args", `${prefix}.args`);
        rejectEmpty(target, "env", `${prefix}.env`);
      }
    }
    for (const runner of ["npx", "uvx"]) {
      const prefix = `payload.packages[${packageIndex}].agent.distribution.${runner}`;
      rejectEmpty(distribution?.[runner], "args", `${prefix}.args`);
      rejectEmpty(distribution?.[runner], "env", `${prefix}.env`);
    }
  });
}

function rejectEmpty(parent, field, label) {
  if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, field)) return;
  const value = parent[field];
  if ((Array.isArray(value) && value.length === 0) || isEmptyObject(value)) {
    throw new Error(`${label} is an empty optional field; omit it before signing`);
  }
}

function isEmptyObject(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    !Object.keys(value).length
  );
}

function parsePrivateKey(bytes) {
  const pem = bytes.toString("utf8");
  if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(pem)) {
    throw new Error("private key must be an Ed25519 PKCS8 PEM file");
  }
  try {
    const key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("private key must be an Ed25519 PKCS8 PEM file");
  }
}
