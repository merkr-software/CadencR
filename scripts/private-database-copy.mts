import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  openSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
} from "node:fs";

/**
 * Copy `source` to `target` as a copy-on-write clone when the filesystem
 * supports it, so a multi-GB dev database shares its blocks with the main
 * checkout until either side writes. Node's FICLONE flag is a no-op on macOS
 * (libuv never calls clonefile), so APFS uses fclonefileat on the checked fd. Other platforms
 * use a bounded full copy through exclusive descriptors.
 * Neither path overwrites an existing destination or removes partial copies.
 */
export function cloneOrCopy(source: string, target: string, platform = process.platform): void {
  assertCopyTargetAbsent(target);
  if (lstatSync(source).isSymbolicLink()) {
    throw new Error(`Refusing symlink database source: ${source}`);
  }
  const descriptor = openSync(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`Not a regular, singly linked database source: ${source}`);
    }
    // copyfile/clonefile inherit the source mode, regardless of the process
    // umask. Tighten the checked source inode before the destination exists.
    if (process.platform !== "win32" && (metadata.mode & 0o7777) !== 0o600) {
      fchmodSync(descriptor, 0o600);
    }
    if (platform === "darwin") {
      // macOS's bundled JavaScript bridge calls the descriptor-based syscall.
      // The source remains fd 3 even if its original pathname is replaced.
      const result = spawnSync(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", DARWIN_CLONE_SCRIPT, "--", target],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", descriptor] },
      );
      if (result.status === 0) {
        verifyPrivateCopy(target);
        return;
      }
      // A failed clone may have created a partial file. Preserve it and stop:
      // the fallback must never overwrite a possible database or partial copy.
      assertCopyTargetAbsent(target);
      console.warn(
        `copy-on-write clone failed (${result.stderr?.trim() || result.error?.message}); copying ${source} instead`,
      );
    }
    copyDatabaseBytes(descriptor, target);
    verifyPrivateCopy(target);
  } finally {
    closeSync(descriptor);
  }
}

const DARWIN_CLONE_SCRIPT = `
ObjC.bindFunction("fclonefileat", ["int", ["int", "int", "char *", "unsigned int"]]);
function run(args) {
  if ($.fclonefileat(3, -2, args[0], 0) !== 0) throw new Error("Descriptor clone failed");
}
`;

function assertCopyTargetAbsent(target: string): void {
  try {
    lstatSync(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Database copy destination already exists; preserving it: ${target}`);
}

function verifyPrivateCopy(target: string): void {
  const descriptor = openSync(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (process.platform !== "win32" && (metadata.mode & 0o7777) !== 0o600)
    ) {
      throw new Error(
        `Database copy is not a private regular file; preserved for inspection: ${target}`,
      );
    }
  } finally {
    closeSync(descriptor);
  }
}

function copyDatabaseBytes(source: number, target: string): void {
  // copyFileSync removes its partial destination on error. Keep our own
  // descriptor so every failed partial copy remains available for inspection.
  const output = openSync(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(source, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        const written = writeSync(output, buffer, offset, count - offset);
        if (written === 0) throw new Error(`Database copy made no progress: ${target}`);
        offset += written;
      }
    }
    fsyncSync(output);
  } finally {
    closeSync(output);
  }
}
