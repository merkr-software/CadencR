import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export async function readBoundedRegularFile(file, limit, label) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (before.size > limit) throw new Error(`${label} exceeds ${formatLimit(limit)}`);
    handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error(`${label} changed while being read`);
    }
    if (metadata.size > limit) throw new Error(`${label} exceeds ${formatLimit(limit)}`);
    const chunks = [];
    let bytes = 0;
    while (bytes <= limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    if (bytes > limit) throw new Error(`${label} exceeds ${formatLimit(limit)}`);
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw new Error(`cannot read ${label}`);
  } finally {
    await handle?.close();
  }
}

function formatLimit(limit) {
  return limit >= 1024 * 1024 ? `${limit / (1024 * 1024)} MiB` : `${limit / 1024} KiB`;
}
