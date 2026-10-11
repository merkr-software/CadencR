import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { readBoundedRegularFile } from "./io.mjs";
import { cleanupFailure, withOwnedLock } from "./files.mjs";
import { createPublicationPlan } from "./plan.mjs";
import { downloadVerifiedArchive, MAX_ARCHIVE_BYTES } from "./download.mjs";

const RECEIPT = "staging-receipt.json";
const LOCK = ".stage.lock";
const MAX_TARGETS = 6;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export async function stagePublication(
  submission,
  repository,
  directory,
  { download = downloadVerifiedArchive } = {},
) {
  const plan = createPublicationPlan(submission, repository);
  if (plan.targets.length > MAX_TARGETS)
    throw new Error(`publication exceeds ${MAX_TARGETS} targets`);
  await ensureDirectory(directory);
  const lockPath = path.join(directory, LOCK);
  return withOwnedLock(lockPath, "staging directory", async () => {
    const ownedPartials = new Set();
    let primaryError;
    let receipt;
    try {
      await validateExistingReceipt(directory, plan);
      const artifacts = [];
      for (const target of plan.targets) {
        artifacts.push(await stageTarget(directory, target, download, ownedPartials));
      }
      receipt = { schema_version: 1, plan, artifacts };
      await publishReceipt(directory, receipt, ownedPartials);
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors = [];
    for (const partial of ownedPartials) {
      await removeOwnedFile(partial).catch((error) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length > 0) throw cleanupFailure(primaryError, cleanupErrors, "staging");
    if (primaryError) throw primaryError;
    return receipt;
  });
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("staging path must be a non-symlink directory");
  }
}

async function validateExistingReceipt(directory, plan) {
  const receiptPath = path.join(directory, RECEIPT);
  try {
    await lstat(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const bytes = await readBoundedRegularFile(receiptPath, MAX_RECEIPT_BYTES, "staging receipt");
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("existing staging receipt is invalid");
  }
  if (canonicalJson(receipt?.plan) !== canonicalJson(plan)) {
    throw new Error("staging directory belongs to a different publication plan");
  }
}

async function stageTarget(directory, target, download, ownedPartials) {
  const finalPath = path.join(directory, target.asset);
  const existing = await hashIfExists(finalPath);
  if (existing) {
    if (existing.sha256 !== target.sha256)
      throw new Error(`existing asset conflicts: ${target.asset}`);
    return { asset: target.asset, ...existing };
  }

  const partial = path.join(directory, `.${target.asset}.${randomBytes(12).toString("hex")}.part`);
  // downloadVerifiedArchive exclusively creates outputPath and removes it on every failure.
  await download({
    url: target.source_url,
    sha256: target.sha256,
    outputPath: partial,
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  ownedPartials.add(partial);
  const verified = await hashRegularFile(
    partial,
    MAX_ARCHIVE_BYTES,
    `downloaded asset ${target.asset}`,
  );
  if (verified.sha256 !== target.sha256)
    throw new Error(`downloaded asset hash mismatch: ${target.asset}`);
  let artifact = { asset: target.asset, ...verified };
  try {
    await link(partial, finalPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const winner = await hashRegularFile(
      finalPath,
      MAX_ARCHIVE_BYTES,
      `existing asset ${target.asset}`,
    );
    if (winner.sha256 !== target.sha256)
      throw new Error(`existing asset conflicts: ${target.asset}`);
    artifact = { asset: target.asset, ...winner };
  }
  await removeOwnedFile(partial);
  ownedPartials.delete(partial);
  return artifact;
}

async function hashIfExists(file) {
  try {
    return await hashRegularFile(file, MAX_ARCHIVE_BYTES, "existing asset");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashRegularFile(file, maxBytes, label) {
  let handle;
  let primaryError;
  try {
    const before = await lstat(file);
    if (before.isSymbolicLink() || !before.isFile())
      throw new Error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds the size limit`);
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error(`${label} changed while being verified`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`${label} exceeds the size limit`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), size };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch((error) => {
        throw cleanupFailure(primaryError, [error]);
      });
    }
  }
}

async function publishReceipt(directory, receipt, ownedPartials) {
  const destination = path.join(directory, RECEIPT);
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error("staging receipt exceeds 4 MiB");
  const partial = path.join(directory, `.${RECEIPT}.${randomBytes(12).toString("hex")}.part`);
  const handle = await open(partial, "wx", 0o600);
  ownedPartials.add(partial);
  let writeError;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await handle.close().catch((error) => {
      throw cleanupFailure(writeError, [error]);
    });
  }
  try {
    await link(partial, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedRegularFile(
      destination,
      MAX_RECEIPT_BYTES,
      "staging receipt",
    );
    if (!existing.equals(bytes)) throw new Error("existing staging receipt conflicts");
  }
  await removeOwnedFile(partial);
  ownedPartials.delete(partial);
}

async function removeOwnedFile(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
