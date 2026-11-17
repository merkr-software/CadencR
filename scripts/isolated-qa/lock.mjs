// A cross-process lock for QA runs of one checkout: a directory created with
// `mkdir` (atomic), whose owner (PID + start time) is published by rename, so
// a waiter never reads a half-written owner and a dead owner's lock is reclaimed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isAlive, readProcessTable } from "./processes.mjs";

/** Lock path for one checkout and purpose, in the shared temp dir (removed on release). */
export function lockPath(repoRoot, purpose, tmp = os.tmpdir()) {
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(tmp, "cadencr-qa-locks", `${key}.${purpose}`);
}

/** The owner a lock publishes, or null while it is being created or removed. */
function readOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Seconds since the lock dir was created, or null once it is gone. */
function lockAgeSec(lock) {
  try {
    return (Date.now() - statSync(lock).mtimeMs) / 1000;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function tryAcquire(lock, owner) {
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  const temporary = join(lock, `owner.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner));
  renameSync(temporary, join(lock, "owner.json"));
  return true;
}

const sameOwner = (a, b) => a?.pid === b?.pid && a?.startedAt === b?.startedAt;

/**
 * Remove a dead owner's lock. Renaming first means only one waiter wins the
 * takeover; the others see ENOENT and retry. The renamed lock must still be the
 * one judged dead: another waiter may have reclaimed it and taken it live in
 * the meantime, and that lock is put back instead of deleted.
 */
function reclaim(lock, judged) {
  const doomed = `${lock}.stale-${process.pid}`;
  try {
    renameSync(lock, doomed);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const owner = readOwner(doomed);
  if (judged ? sameOwner(owner, judged) : owner === null) {
    rmSync(doomed, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(doomed, lock);
  } catch (error) {
    // A third waiter already took a fresh lock: it wins, the superseded one goes.
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    rmSync(doomed, { recursive: true, force: true });
  }
}

function ownStart() {
  const self = readProcessTable().find((row) => row.pid === process.pid);
  if (!self) throw new Error(`ps does not list this process (pid ${process.pid})`);
  return self.startedAt;
}

/** Run `task` while holding the lock; waits (without a deadline) for a live owner. */
export async function withLock(lock, label, task) {
  mkdirSync(join(lock, ".."), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, startedAt: ownStart(), label };
  let announced = false;
  while (!tryAcquire(lock, owner)) {
    const holder = readOwner(lock);
    const age = lockAgeSec(lock);
    // No owner after 10 s: its creator died between mkdir and publishing.
    const dead = holder ? !isAlive(holder) : age !== null && age > 10;
    if (dead) {
      reclaim(lock, holder);
      continue;
    }
    if (holder && !announced) console.log(`Waiting for ${holder.label}…`);
    announced = announced || holder !== null;
    await delay(1_000);
  }
  try {
    return await task();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
