import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../lib.mjs";
import { publishCanonicalReceipt, writeExclusivePrivate } from "./files.mjs";
import { readBoundedRegularFile } from "./io.mjs";

const STATE_LIMIT = 4 * 1024 * 1024;

export async function ensureStateDirectory(directory) {
  const absolute = path.resolve(directory);
  await rejectAliasedAncestors(absolute, false);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await rejectAliasedAncestors(absolute, true);
}

async function rejectAliasedAncestors(absolute, requireAll) {
  let cursor = path.parse(absolute).root;
  for (const segment of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new Error("pipeline state path contains a non-directory or symbolic link");
    } catch (error) {
      if (error?.code !== "ENOENT" || requireAll) throw error;
      return;
    }
  }
}

export async function bindRequest(directory, binding) {
  await publishCanonicalReceipt(
    directory,
    "pipeline-request.json",
    binding,
    STATE_LIMIT,
    "pipeline request binding",
  );
}

export async function materializeInputs(directory, prepared) {
  await ensureStateDirectory(path.join(directory, "inputs"));
  await ensureStateDirectory(path.join(directory, "publications"));
  await writeBytesOnce(
    path.join(directory, "inputs", "public-key.pem"),
    prepared.publicKey.bytes,
    "public key copy",
  );
  if (prepared.previous)
    await writeBytesOnce(
      path.join(directory, "inputs", "previous-index.json"),
      prepared.previous.bytes,
      "previous index copy",
    );
  for (const [index, entry] of prepared.entries.entries()) {
    await ensureStateDirectory(entry.directory);
    await writeBytesOnce(
      path.join(entry.directory, "submission.json"),
      entry.bytes,
      `submission ${index + 1} copy`,
    );
  }
}

export async function writeCanonicalOnce(file, value, label) {
  return writeBytesOnce(file, Buffer.from(`${canonicalJson(value)}\n`), label);
}

async function writeBytesOnce(file, bytes, label) {
  try {
    await writeExclusivePrivate(file, bytes, label);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readBoundedRegularFile(file, Math.max(bytes.length, STATE_LIMIT), label);
    if (!existing.equals(bytes)) throw new Error(`existing ${label} conflicts`);
  }
}
