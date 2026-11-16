import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ELF_MACHINE, prepareLinuxSidecar, readElfMachine } = require(
  "../packages/desktop/build/linux-sidecar.cjs",
);

function elfHeader(machine, { littleEndian = true } = {}) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2; // 64-bit
  header[5] = littleEndian ? 1 : 2;
  if (littleEndian) header.writeUInt16LE(machine, 18);
  else header.writeUInt16BE(machine, 18);
  return header;
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-linux-sidecar-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("reads the ELF machine in either byte order and rejects non-ELF files", (t) => {
  const dir = scratch(t);
  const little = join(dir, "little");
  const big = join(dir, "big");
  const macho = join(dir, "macho");
  const short = join(dir, "short");
  writeFileSync(little, elfHeader(ELF_MACHINE.x64));
  writeFileSync(big, elfHeader(ELF_MACHINE.arm64, { littleEndian: false }));
  writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Buffer.alloc(60)]));
  writeFileSync(short, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

  assert.equal(readElfMachine(little), 62);
  assert.equal(readElfMachine(big), 183);
  assert.equal(readElfMachine(macho), null);
  assert.equal(readElfMachine(short), null);
});

test("prepares a matching sidecar and marks it executable", (t) => {
  const binary = join(scratch(t), "cadencr-service");
  writeFileSync(binary, elfHeader(ELF_MACHINE.x64), { mode: 0o644 });

  prepareLinuxSidecar(binary, "x64");

  assert.equal(statSync(binary).mode & 0o777, 0o755);
});

test("refuses missing, wrong-arch, non-ELF and unsupported-arch sidecars", (t) => {
  const dir = scratch(t);
  const arm = join(dir, "arm");
  const macho = join(dir, "macho");
  writeFileSync(arm, elfHeader(ELF_MACHINE.arm64));
  writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, ...Buffer.alloc(60)]));

  assert.throws(() => prepareLinuxSidecar(join(dir, "missing"), "x64"), /Missing/);
  assert.throws(() => prepareLinuxSidecar(arm, "x64"), /ELF machine 183.*needs ELF machine 62/);
  assert.throws(() => prepareLinuxSidecar(macho, "arm64"), /not an ELF executable/);
  assert.throws(() => prepareLinuxSidecar(arm, "ia32"), /Unsupported Linux package arch/);
});

test("prepares the bundled CLI like the sidecar", (t) => {
  const dir = scratch(t);
  const binary = join(dir, "cadencr");
  writeFileSync(binary, elfHeader(ELF_MACHINE.x64), { mode: 0o644 });
  prepareLinuxSidecar(binary, "x64", "the cadencr CLI");
  assert.equal(statSync(binary).mode & 0o777, 0o755);
});
