import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  publishCanonicalReceipt,
  withOwnedLock,
  writeExclusivePrivate,
} from "../scripts/publication/files.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "publication-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, ".lock");
}

test("owned locks are exclusive and removed after success", async (t) => {
  const lock = await fixture(t);
  await withOwnedLock(lock, "test directory", async () => {
    await assert.rejects(
      withOwnedLock(lock, "test directory", async () => {}),
      /already locked/,
    );
  });
  await withOwnedLock(lock, "test directory", async () => {});
});

test("operation errors survive successful lock cleanup", async (t) => {
  const lock = await fixture(t);
  await assert.rejects(
    withOwnedLock(lock, "test directory", async () => {
      throw new Error("primary operation failure");
    }),
    /primary operation failure/,
  );
  await withOwnedLock(lock, "test directory", async () => {});
});

test("inode ownership preserves a foreign replacement", async (t) => {
  const lock = await fixture(t);
  await withOwnedLock(lock, "test directory", async () => {
    await unlink(lock);
    await writeFile(lock, "foreign", { flag: "wx" });
  });
  assert.equal(await readFile(lock, "utf8"), "foreign");
});

test("immutable receipt reconciliation cleans its temporary file on malformed or symlink destinations", async (t) => {
  const lock = await fixture(t);
  const directory = path.dirname(lock);
  await writeFile(path.join(directory, "malformed.json"), "not json");
  await assert.rejects(
    publishCanonicalReceipt(directory, "malformed.json", { ok: true }, 1024, "test receipt"),
    /invalid/,
  );
  const foreign = path.join(directory, "foreign.json");
  await writeFile(foreign, "preserve");
  await symlink(foreign, path.join(directory, "linked.json"));
  await assert.rejects(
    publishCanonicalReceipt(directory, "linked.json", { ok: true }, 1024, "test receipt"),
  );
  assert.equal(await readFile(foreign, "utf8"), "preserve");
  assert.equal(await readFile(path.join(directory, "malformed.json"), "utf8"), "not json");
  assert.ok((await readdir(directory)).every((name) => !name.endsWith(".part")));
});

test("exclusive private writes publish only complete bytes and clean failures", async (t) => {
  const lock = await fixture(t);
  const directory = path.dirname(lock);
  const output = path.join(directory, "output.json");
  await assert.rejects(writeExclusivePrivate(output, undefined));
  await assert.rejects(readFile(output), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
  await writeExclusivePrivate(output, Buffer.from("complete"));
  await assert.rejects(writeExclusivePrivate(output, Buffer.from("conflict")), { code: "EEXIST" });
  assert.equal(await readFile(output, "utf8"), "complete");
  assert.deepEqual(await readdir(directory), ["output.json"]);
});
