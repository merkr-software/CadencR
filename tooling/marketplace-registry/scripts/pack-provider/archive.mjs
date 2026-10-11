import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export const MAX_ARCHIVE_ENTRIES = 4_096;
export const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_SINGLE_FILE_BYTES = 256 * 1024 * 1024;
const BLOCK = 512;
const SECRET_NAMES = new Set([".env", ".git", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
const SECRET_SUFFIXES = [".key", ".p12", ".pfx", ".pem"];
const WINDOWS_DEVICES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export async function collectStaging(directory) {
  const inputInfo = await lstat(directory, { bigint: true });
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) {
    throw new Error("staging directory must be a real directory, not a symlink");
  }
  const root = await realpath(directory);
  const rootInfo = await lstat(root, { bigint: true });
  const entries = [];
  let fileBytes = 0;
  async function visit(relative) {
    const names = await boundedNames(path.join(root, relative), entries.length);
    const portable = new Set();
    for (const name of names) {
      validatePortableName(name, relative, portable);
      rejectSecretName(name, relative);
      const child = relative ? `${relative}/${name}` : name;
      const source = path.join(root, child);
      const info = await lstat(source, { bigint: true });
      if (info.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${child}`);
      if (!info.isFile() && !info.isDirectory())
        throw new Error(`special files are forbidden: ${child}`);
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw limitError();
      if (info.isFile()) {
        if (info.size > BigInt(MAX_SINGLE_FILE_BYTES)) {
          throw new Error(`file exceeds ${MAX_SINGLE_FILE_BYTES} bytes: ${child}`);
        }
        fileBytes += Number(info.size);
        if (fileBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error(`package exceeds ${MAX_UNCOMPRESSED_BYTES} uncompressed bytes`);
        }
      }
      entries.push({
        path: child,
        directory: info.isDirectory(),
        executable: Boolean(info.mode & 0o111n),
        identity: identity(info),
        canonical: await realpath(source),
      });
      if (info.isDirectory()) await visit(child);
    }
  }
  await visit("");
  Object.defineProperty(entries, "rootIdentity", { value: identity(rootInfo) });
  return { root, entries };
}

async function boundedNames(directory, existingCount) {
  const names = [];
  const remaining = MAX_ARCHIVE_ENTRIES - existingCount;
  const handle = await opendir(directory);
  for await (const item of handle) {
    names.push(item.name);
    if (names.length > remaining) throw limitError();
  }
  return names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export async function assertPackageFiles(root, entries, targetName, target, assets) {
  const files = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.path));
  for (const [label, relative] of [
    ["entrypoint", target.cmd],
    ["icon asset", assets.icon],
    ["readme asset", assets.readme],
    ["license asset", assets.license],
  ]) {
    if (relative != null && !files.has(relative)) {
      throw new Error(`${label} is missing from staging directory: ${relative}`);
    }
  }
  const command = entries.find((entry) => entry.path === target.cmd);
  if (!targetName.startsWith("windows-") && !command?.executable) {
    throw new Error(`entrypoint is not executable: ${target.cmd}`);
  }
  await access(path.join(root, target.cmd), constants.R_OK);
}

export async function buildArchive(root, entries, output, options = {}) {
  let destination;
  let created = false;
  try {
    destination = await (options.openDestination ?? openDestination)(output);
    created = true;
    const digest = hashingTransform();
    await pipeline(
      Readable.from(tarChunks(root, entries)),
      createGzip({ level: 9, mtime: 0 }),
      digest.stream,
      destination.stream,
    );
    await verifySnapshot(root, entries);
    await destination.sync();
    await destination.close();
    destination = undefined;
    return digest.result();
  } catch (primary) {
    const cleanupErrors = [];
    if (destination) await recordCleanup(cleanupErrors, () => destination.close());
    if (created) await recordCleanup(cleanupErrors, () => unlink(output));
    if (cleanupErrors.length) {
      const cleanupSummary = cleanupErrors
        .slice(0, 3)
        .map((error) => boundedMessage(error))
        .join("; ");
      throw new AggregateError(
        [primary, ...cleanupErrors],
        `${boundedMessage(primary)}; cleanup failed: ${cleanupSummary}`,
      );
    }
    throw primary;
  }
}

async function openDestination(output) {
  const handle = await open(output, "wx", 0o644);
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        writeAll(handle, chunk).then(() => callback(), callback);
      },
    }),
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten === 0) throw new Error("archive output stopped accepting bytes");
    offset += bytesWritten;
  }
}

function hashingTransform() {
  const hash = createHash("sha256");
  let size = 0;
  return {
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }),
    result: () => ({ sha256: hash.digest("hex"), size }),
  };
}

async function* tarChunks(root, entries) {
  for (const entry of entries) {
    await verifyPath(root, entry);
    const size = entry.directory ? 0 : Number(entry.identity.size);
    yield tarHeader(entry, size);
    if (!entry.directory) yield* fileChunks(root, entry);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(BLOCK * 2);
}

async function* fileChunks(root, entry) {
  const handle = await open(
    path.join(root, entry.path),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    assertIdentity(entry, await handle.stat({ bigint: true }));
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > Number(entry.identity.size))
        throw new Error(`file grew while packaging: ${entry.path}`);
      yield chunk;
    }
    if (bytes !== Number(entry.identity.size))
      throw new Error(`file changed while packaging: ${entry.path}`);
    assertIdentity(entry, await handle.stat({ bigint: true }));
  } finally {
    await handle.close();
  }
}

async function verifySnapshot(root, entries) {
  assertRawIdentity(
    entries.rootIdentity,
    await lstat(root, { bigint: true }),
    "staging root changed while packaging",
  );
  const current = await collectStaging(root);
  if (current.entries.length !== entries.length)
    throw new Error("staging tree changed while packaging");
  for (let index = 0; index < entries.length; index += 1) {
    const before = entries[index];
    const after = current.entries[index];
    if (before.path !== after.path || before.canonical !== after.canonical) {
      throw new Error("staging tree changed while packaging");
    }
    assertRawIdentity(
      before.identity,
      after.identity,
      `file changed while packaging: ${before.path}`,
    );
  }
}

async function verifyPath(root, entry) {
  const source = path.join(root, entry.path);
  const canonical = await realpath(source);
  if (canonical !== entry.canonical || !isWithin(root, canonical)) {
    throw new Error(`path changed while packaging: ${entry.path}`);
  }
  assertIdentity(entry, await lstat(source, { bigint: true }));
}

function assertIdentity(entry, info) {
  if (info.isSymbolicLink() || (entry.directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`file changed while packaging: ${entry.path}`);
  }
  assertRawIdentity(entry.identity, info, `file changed while packaging: ${entry.path}`);
}

function assertRawIdentity(expected, info, message) {
  if (Object.entries(expected).some(([key, value]) => info[key] !== value))
    throw new Error(message);
}

function identity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

async function recordCleanup(errors, action) {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

function validatePortableName(name, parent, seen) {
  const rendered = parent ? `${parent}/${name}` : name;
  if (/[<>:"\\|?*\u0000-\u001f]/u.test(name) || /[ .]$/u.test(name) || WINDOWS_DEVICES.test(name)) {
    throw new Error(`non-portable package path is forbidden: ${rendered}`);
  }
  const folded = name.normalize("NFC").toLowerCase();
  if (seen.has(folded)) throw new Error(`portable path collision is forbidden: ${rendered}`);
  seen.add(folded);
}

function rejectSecretName(name, parent) {
  const lower = name.toLowerCase();
  if (
    SECRET_NAMES.has(lower) ||
    lower.startsWith(".env.") ||
    SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  ) {
    throw new Error(`secret-prone path is forbidden: ${parent ? `${parent}/` : ""}${name}`);
  }
}

function tarHeader(entry, size) {
  const header = Buffer.alloc(BLOCK);
  const archivePath = entry.directory ? `${entry.path}/` : entry.path;
  const { name, prefix } = splitTarPath(archivePath);
  putText(header, 0, 100, name);
  putOctal(header, 100, 8, entry.directory ? 0o755 : entry.executable ? 0o755 : 0o644);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, size);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.directory ? 0x35 : 0x30;
  putText(header, 257, 6, "ustar\0");
  putText(header, 263, 2, "00");
  putText(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putText(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`path cannot be represented safely in a portable TAR header: ${value}`);
}

function putText(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`TAR field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function putOctal(buffer, offset, length, value) {
  const rendered = value.toString(8).padStart(length - 1, "0");
  if (rendered.length >= length) throw new Error(`value is too large for TAR header: ${value}`);
  putText(buffer, offset, length - 1, rendered);
  buffer[offset + length - 1] = 0;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function limitError() {
  return new Error(`package exceeds ${MAX_ARCHIVE_ENTRIES} entries`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedMessage(error) {
  const message = errorMessage(error);
  return message.length <= 300 ? message : `${message.slice(0, 297)}...`;
}
