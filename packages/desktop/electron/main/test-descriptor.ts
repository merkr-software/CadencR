import { fstatSync } from "node:fs";

/**
 * Test helper: true once `descriptor` no longer refers to the reserved file.
 *
 * `fstatSync` throwing EBADF is not a reliable signal on its own: vitest runs
 * files in worker threads that share this process's descriptor table, so a
 * closed number can be handed to another test's `open` before we look at it.
 * A reused descriptor points at a different inode, which still proves ours was
 * closed.
 */
export function descriptorReleased(
  descriptor: number,
  file: { device: number; inode: number },
): boolean {
  try {
    const stat = fstatSync(descriptor);
    return stat.ino !== file.inode || stat.dev !== file.device;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EBADF") return true;
    throw error;
  }
}
