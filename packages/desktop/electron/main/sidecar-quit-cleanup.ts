import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { childProcessEnv } from "./child-env";
import { QuitSlotUnavailable, recordSpawnedSidecarQuit } from "./sidecar-quit-journal";

const CLEANUP_TIMEOUT_MS = 45_000;
const exec = promisify(execFile);

/** Persist the decision first. Only the installed binary can confirm that
 * the exact interrupted service's owned work has ceased. */
export function createExitedSidecarQuit(
  binary: string,
  database: string,
  epoch: string,
): (unattached?: boolean) => Promise<boolean> {
  let selected = false;
  return async (unattached = false) => {
    if (!selected) {
      try {
        if (!(await recordSpawnedSidecarQuit(database, epoch, unattached))) return false;
        selected = true;
      } catch (error: unknown) {
        // A racing startup may have completed this quit. The binary checks
        // the receipt for the exact epoch before considering any other work.
        if (!(error instanceof QuitSlotUnavailable)) throw error;
      }
    }
    await stopExitedWork(binary, database, epoch);
    return true;
  };
}

async function stopExitedWork(binary: string, database: string, epoch: string): Promise<void> {
  try {
    await exec(binary, ["--internal-desktop-quit-cleanup", database, epoch], {
      env: childProcessEnv(process.env),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: CLEANUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error: unknown) {
    throw new Error(
      `Cadencr could not verify that the crashed service's agents stopped. Try quitting again.\n\n${cleanupFailureDetail(error)}`,
      {
        cause: error,
      },
    );
  }
}

function cleanupFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (
    "killed" in error &&
    error.killed === true &&
    "signal" in error &&
    error.signal === "SIGKILL"
  ) {
    return "The cleanup did not finish in time.";
  }
  return (
    ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) || error.message
  );
}
