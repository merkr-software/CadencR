import { translateUi } from "./ui-i18n";

/**
 * The packaged service as Electron's main process supervises it. `down` means
 * it exited while the app still needed it; the window offers a restart.
 */
export type ServiceStatus =
  | { state: "running" }
  | { state: "restarting" }
  | { state: "down"; detail: string; reason?: "newer-database" };

export function newerDatabaseRecoveryDetail(): string {
  return translateUi(
    "system.recovery.newerDetail",
    "This database was updated by a newer version of Cadencr. Install the latest version to continue, or restore a pre-migration backup if you need to use this older version.",
  );
}
