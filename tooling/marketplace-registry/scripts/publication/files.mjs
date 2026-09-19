import { randomBytes } from "node:crypto";
import { link, lstat, mkdtemp, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { readBoundedRegularFile } from "./io.mjs";

export async function withOwnedLock(lockPath, label, operation) {
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} is already locked`);
    throw error;
  }
  let identity;
  let primary;
  let result;
  try {
    identity = await lock.stat();
    result = await operation();
  } catch (error) {
    primary = error;
  }
  const failures = [];
  await lock.close().catch((error) => failures.push(error));
  if (identity) await removeOwnedLock(lockPath, identity).catch((error) => failures.push(error));
  if (failures.length) throw cleanupFailure(primary, failures, cleanupLabel(label));
  if (primary) throw primary;
  return result;
}

export function cleanupFailure(primary, failures, label = "publication") {
  const message = primary
    ? `${primary.message}; ${label} cleanup also failed (${failures.length} operation(s))`
    : `${label} cleanup failed (${failures.length} operation(s))`;
  return new Error(message, {
    cause: new AggregateError(primary ? [primary, ...failures] : failures),
  });
}

export async function withOwnedTemporaryDirectory(directory, prefix, operation) {
  const temporary = await mkdtemp(path.join(directory, prefix));
  let result;
  let primary;
  try {
    result = await operation(temporary);
  } catch (error) {
    primary = error;
  }
  const failures = [];
  await rm(temporary, { recursive: true }).catch((error) => failures.push(error));
  if (failures.length) throw cleanupFailure(primary, failures);
  if (primary) throw primary;
  return result;
}

export async function publishCanonicalReceipt(directory, name, receipt, limit, label) {
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  if (bytes.length > limit) throw new Error(`${label} exceeds 4 MiB`);
  const temporary = path.join(directory, `.${name}.${randomBytes(12).toString("hex")}.part`);
  let primary;
  await writeExclusivePrivate(temporary, bytes, label);
  try {
    await link(temporary, path.join(directory, name));
  } catch (error) {
    if (error?.code !== "EEXIST") primary = error;
    else primary = await compareCanonical(path.join(directory, name), receipt, limit, label);
  }
  const failures = [];
  await unlink(temporary).catch((error) => failures.push(error));
  if (failures.length) throw cleanupFailure(primary, failures);
  if (primary) throw primary;
}

async function compareCanonical(file, receipt, limit, label) {
  try {
    const existing = await readBoundedRegularFile(file, limit, label);
    let parsed;
    try {
      parsed = JSON.parse(existing.toString("utf8"));
    } catch {
      return new Error(`existing ${label} is invalid`);
    }
    if (canonicalJson(parsed) !== canonicalJson(receipt)) {
      return new Error(`existing ${label} conflicts`);
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

export async function writeExclusivePrivate(file, bytes, label = "publication") {
  await withOwnedTemporaryDirectory(
    path.dirname(path.resolve(file)),
    ".publication-output-",
    async (directory) => {
      const staged = path.join(directory, "output");
      const handle = await open(staged, "wx", 0o600);
      let primary;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } catch (error) {
        primary = error;
      }
      const failures = [];
      await handle.close().catch((error) => failures.push(error));
      if (failures.length) throw cleanupFailure(primary, failures, label);
      if (primary) throw primary;
      await link(staged, file);
    },
  );
}

async function removeOwnedLock(lockPath, identity) {
  try {
    const current = await lstat(lockPath);
    if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function cleanupLabel(label) {
  return label.endsWith(" directory") ? label.slice(0, -" directory".length) : label;
}
