const { chmodSync, closeSync, existsSync, openSync, readSync } = require("node:fs");

// electron-builder arch → ELF `e_machine` of a matching Linux executable.
const ELF_MACHINE = { x64: 62, arm64: 183 };

const ELF_MAGIC = 0x7f454c46;
const ELF_MACHINE_OFFSET = 18;

/** The ELF `e_machine` field of `binary`, or `null` when it is not an ELF file. */
function readElfMachine(binary) {
  const header = Buffer.alloc(ELF_MACHINE_OFFSET + 2);
  const fd = openSync(binary, "r");
  let bytesRead;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (bytesRead < header.length || header.readUInt32BE(0) !== ELF_MAGIC) return null;
  const littleEndian = header[5] === 1;
  return littleEndian
    ? header.readUInt16LE(ELF_MACHINE_OFFSET)
    : header.readUInt16BE(ELF_MACHINE_OFFSET);
}

/**
 * Refuse to package a missing or wrong-arch native binary (the sidecar, the
 * `cadencr` CLI) — the Linux counterpart of the macOS `lipo` guard: v0.13.0
 * shipped an Intel app whose backend could not start — then mark it executable
 * for AppImage/deb/rpm.
 */
function prepareLinuxSidecar(binary, arch, label = "cadencr-service") {
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) throw new Error(`Unsupported Linux package arch: ${arch}`);
  if (!existsSync(binary)) throw new Error(`Missing ${binary}`);
  const machine = readElfMachine(binary);
  if (machine !== expected) {
    const actual = machine === null ? "not an ELF executable" : `ELF machine ${machine}`;
    throw new Error(`${binary} is ${actual}, but the ${arch} package needs ELF machine ${expected}`);
  }
  try {
    chmodSync(binary, 0o755);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to mark ${label} executable at ${binary}: ${message}`);
  }
}

module.exports = { ELF_MACHINE, prepareLinuxSidecar, readElfMachine };
