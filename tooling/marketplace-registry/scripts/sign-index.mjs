#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson, validateIndex, validateSignedIndex } from "./lib.mjs";
import { readBoundedRegularFile } from "./publication/io.mjs";

const LIMITS = { payload: 32 * 1024 * 1024, privateKey: 16 * 1024 };
const USAGE = "usage: sign-index.mjs --payload FILE --private-key FILE --key-id ID --output FILE";

function parseArgs(argv) {
  const names = new Set(["--payload", "--private-key", "--key-id", "--output"]);
  if (argv.length !== names.size * 2) throw new Error(USAGE);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || values.has(name) || !value || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(name, value);
  }
  if (values.size !== names.size) throw new Error(USAGE);
  return {
    payload: values.get("--payload"),
    privateKey: values.get("--private-key"),
    keyId: values.get("--key-id"),
    output: values.get("--output"),
  };
}

function parsePayload(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("payload must be valid JSON");
  }
}

function validateCanonicalTimestamps(signed) {
  const canonicalUtcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  for (const field of ["generated_at", "expires_at"]) {
    const value = signed?.[field];
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (
      typeof value === "string" &&
      (!canonicalUtcSecond.test(value) ||
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloadBytes = await readBoundedRegularFile(args.payload, LIMITS.payload, "payload");
  const signed = parsePayload(payloadBytes);
  validateCanonicalTimestamps(signed);
  validateCanonicalOptionalFields(signed);
  const payloadErrors = validateIndex(signed);
  if (payloadErrors.length) {
    throw new Error(`payload validation failed:\n${payloadErrors.join("\n")}`);
  }

  const keyBytes = await readBoundedRegularFile(args.privateKey, LIMITS.privateKey, "private key");
  const privateKey = parsePrivateKey(keyBytes);
  const canonicalPayload = Buffer.from(canonicalJson(signed));
  const signatureBytes = sign(null, canonicalPayload, privateKey);
  const publicKey = createPublicKey(privateKey);
  if (!verify(null, canonicalPayload, publicKey, signatureBytes)) {
    throw new Error("signature self-verification failed");
  }

  const envelope = {
    signed,
    signature: {
      algorithm: "ed25519",
      key_id: args.keyId,
      value: signatureBytes.toString("base64"),
    },
  };
  const envelopeErrors = validateSignedIndex(envelope);
  if (envelopeErrors.length) {
    throw new Error(`envelope validation failed:\n${envelopeErrors.join("\n")}`);
  }
  await writeFile(args.output, `${canonicalJson(envelope)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`wrote signed index: ${args.output}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unexpected failure";
  console.error(`sign-index: ${message}`);
  process.exitCode = 1;
});
