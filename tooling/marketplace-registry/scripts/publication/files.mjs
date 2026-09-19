import { lstat, open, unlink } from "node:fs/promises";

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
