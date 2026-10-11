import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_ARCHIVE_BYTES } from "./download.mjs";
import { hashRegularFile } from "./stage.mjs";

export async function captureArchives(entry) {
  const owned = [];
  for (const target of entry.plan.targets) {
    const file = path.join(entry.directory, target.asset);
    const identity = await lstat(file);
    const verified = await hashRegularFile(file, MAX_ARCHIVE_BYTES, "transient archive");
    const after = await lstat(file);
    if (
      identity.dev !== after.dev ||
      identity.ino !== after.ino ||
      verified.sha256 !== target.sha256
    )
      throw new Error("transient archive changed before publication");
    owned.push({ file, identity });
  }
  return owned;
}

export async function releaseArchives(owned) {
  for (const { file, identity } of owned) {
    try {
      const current = await lstat(file);
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
