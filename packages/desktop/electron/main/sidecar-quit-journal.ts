import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";

/** This directory is shared with the service and sits outside the database directory. */
export function sidecarQuitDirectory(canonicalDatabasePath: string): string {
  return path.join(path.dirname(path.dirname(canonicalDatabasePath)), "desktop-recovery");
}

export class QuitSlotUnavailable extends Error {
  constructor() {
    super(
      "Cadencr could not confirm the stop for the service that crashed. The interruption may already be recovering. Try quitting again after the service is ready.",
    );
  }
}

/** Select Stop for this exact dead service, before another service claims recovery. */
export async function recordQuitAfterSidecarExit(
  directory: string,
  epoch: string,
  unattached = false,
): Promise<boolean> {
  const armed = path.join(directory, `${epoch}.armed`);
  const quit = path.join(directory, `${epoch}.quit`);
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if (unattached && fileMissing(error)) return null;
    throw error;
  });
  if (!directoryHandle) return false;
  try {
    try {
      await rename(armed, quit);
    } catch (error: unknown) {
      if (!fileMissing(error)) throw error;
      const selected = await statSlot(quit);
      if (!selected?.isFile()) {
        if (
          unattached &&
          !selected &&
          !(await statSlot(path.join(directory, `${epoch}.recovering`)))
        ) {
          return false;
        }
        throw new QuitSlotUnavailable();
      }
    }
    await directoryHandle.sync();
    return true;
  } finally {
    await directoryHandle.close();
  }
}

export async function recordSpawnedSidecarQuit(
  database: string,
  epoch: string,
  unattached = false,
): Promise<boolean> {
  const canonical = await realpath(database).catch((error: unknown) => {
    if (unattached && fileMissing(error)) return null;
    throw error;
  });
  return (
    canonical !== null &&
    recordQuitAfterSidecarExit(sidecarQuitDirectory(canonical), epoch, unattached)
  );
}

function statSlot(file: string): Promise<Stats | null> {
  return lstat(file).catch((error: unknown) => {
    if (fileMissing(error)) return null;
    throw error;
  });
}

function fileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
