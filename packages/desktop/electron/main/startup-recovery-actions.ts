import { clipboard, dialog } from "electron";
import { openExternal } from "./ipc";
import type { SplashHandle } from "./splash";
import {
  restoreBackupOverDatabase,
  type StartupRecoveryActionId,
  type StartupRecoveryState,
} from "./startup-recovery";

export const LATEST_RELEASE_URL = "https://github.com/merkr-software/CadencR/releases/latest";

export interface StartupRecoveryActionRequest {
  action: StartupRecoveryActionId;
  recovery: StartupRecoveryState | null;
  splash: SplashHandle | null;
  quit: () => void;
}

export async function handleStartupRecoveryAction(
  request: StartupRecoveryActionRequest,
): Promise<void> {
  if (!request.recovery) return;
  try {
    await performStartupRecoveryAction(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    request.splash?.setError(
      request.recovery.title,
      `Recovery action failed: ${message}`,
      request.recovery.actions,
    );
  }
}

async function performStartupRecoveryAction(request: StartupRecoveryActionRequest): Promise<void> {
  switch (request.action) {
    case "download_latest":
      await openExternal(LATEST_RELEASE_URL);
      break;
    case "copy_diagnostics":
      clipboard.writeText(request.recovery?.diagnostics ?? "");
      request.splash?.setError(
        request.recovery?.title ?? "Cadencr couldn't start",
        "Diagnostics copied to clipboard.",
        request.recovery?.actions ?? [],
      );
      break;
    case "restore_backup":
      await restoreStartupBackup(request);
      break;
    case "quit":
      request.quit();
      break;
  }
}

async function restoreStartupBackup(request: StartupRecoveryActionRequest): Promise<void> {
  const recovery = request.recovery;
  if (!recovery?.backup || !recovery.dbPath) {
    request.splash?.setError(
      recovery?.title ?? "Cadencr couldn't start",
      "No pre-migration backup was found.",
      recovery?.actions ?? [],
    );
    return;
  }

  const restorePrompt = {
    type: "warning" as const,
    buttons: ["Restore backup", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Restore pre-migration backup?",
    detail: `This will replace the current database with:\n${recovery.backup.path}\n\nYou should only do this if you need to run this older Cadencr version.`,
  };
  const response = request.splash
    ? await dialog.showMessageBox(request.splash.window, restorePrompt)
    : await dialog.showMessageBox(restorePrompt);
  if (response.response !== 0) return;

  restoreBackupOverDatabase({
    dbPath: recovery.dbPath,
    backupPath: recovery.backup.path,
  });
  request.splash?.setError(
    "Backup restored",
    "Quit and reopen Cadencr to start from the restored database.",
    recovery.actions.filter((candidate) => candidate.id !== "restore_backup"),
  );
}
