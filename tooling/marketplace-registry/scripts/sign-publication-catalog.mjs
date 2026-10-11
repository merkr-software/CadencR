#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNamedArguments } from "./publication/cli.mjs";
import {
  preparePublishedCatalog,
  readPublicationManifest,
  writeCatalogExclusively,
} from "./publication/catalog.mjs";
import { signIndexPayload, validateSigningKeyId } from "./publication/signing.mjs";
import { readBoundedRegularFile } from "./publication/io.mjs";

const FLAGS = [
  "--manifest",
  "--generated-at",
  "--expires-at",
  "--private-key",
  "--key-id",
  "--output",
];
const USAGE = `Usage: node scripts/sign-publication-catalog.mjs ${FLAGS.join(" VALUE ")}`;

export async function signPublicationCatalog(options) {
  await assertOutputAbsent(options.output);
  validateSigningKeyId(options.keyId);
  const manifestFile = path.resolve(options.manifest);
  const manifest = await readPublicationManifest(manifestFile);
  if (manifest.baseline) {
    if (manifest.baseline.key_id !== options.keyId)
      throw new Error("baseline signing key id does not match");
    const publicBytes = await readBoundedRegularFile(
      path.resolve(path.dirname(manifestFile), manifest.baseline.public_key),
      16 * 1024,
      "public key",
    );
    const privateBytes = await readBoundedRegularFile(options.privateKey, 16 * 1024, "private key");
    const derived = createPublicKey(createPrivateKey(privateBytes)).export({
      type: "spki",
      format: "der",
    });
    const pinned = createPublicKey(publicBytes).export({ type: "spki", format: "der" });
    if (!derived.equals(pinned))
      throw new Error("private key does not match pinned baseline public key");
  }
  const now = options.now ?? new Date();
  const payload = await preparePublishedCatalog(manifest, {
    baseDirectory: path.dirname(manifestFile),
    generatedAt: options.generatedAt,
    expiresAt: options.expiresAt,
    download: options.download,
    now,
  });
  const signingOptions = {
    privateKeyFile: options.privateKey,
    keyId: options.keyId,
  };
  if (options.now !== undefined) signingOptions.now = options.now;
  const envelope = await (options.sign ?? signIndexPayload)(payload, signingOptions);
  await writeCatalogExclusively(options.output, envelope);
  return envelope;
}

async function assertOutputAbsent(file) {
  const parent = path.dirname(path.resolve(file));
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error("output directory must be a non-symlink directory");
  }
  try {
    await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output already exists");
}

async function main() {
  const values = parseNamedArguments(process.argv.slice(2), FLAGS);
  await signPublicationCatalog({
    manifest: values.manifest,
    generatedAt: values["generated-at"],
    expiresAt: values["expires-at"],
    privateKey: values["private-key"],
    keyId: values["key-id"],
    output: values.output,
  });
  console.log(`wrote signed publication catalog: ${values.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `sign-publication-catalog: ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    console.error(USAGE);
    process.exitCode = 1;
  });
}
