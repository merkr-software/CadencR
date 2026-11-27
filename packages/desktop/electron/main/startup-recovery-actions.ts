import { translateUi as t } from "../../src/shared/ui-i18n";
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
      t("system.recovery.actionFailure", "Recovery action failed: {{message}}", { message }),
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
        request.recovery?.title ?? t("system.recovery.failedTitle", "Cadencr couldn't start"),
        t("system.recovery.copied", "Diagnostics copied to clipboard."),
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
      recovery?.title ?? t("system.recovery.failedTitle", "Cadencr couldn't start"),
      t("system.recovery.noBackup", "No pre-migration backup was found."),
      recovery?.actions ?? [],
    );
    return;
  }

  const restorePrompt = {
    type: "warning" as const,
    buttons: [t("system.recovery.confirmRestore", "Restore backup"), t("common.cancel", "Cancel")],
    defaultId: 1,
    cancelId: 1,
    message: t("system.recovery.restoreQuestion", "Restore pre-migration backup?"),
    detail: t(
      "system.recovery.confirmRestoreDetail",
      "This will replace the current database with:\n{{path}}\n\nYou should only do this if you need to run this older Cadencr version.",
      { path: recovery.backup.path },
    ),
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
    t("system.recovery.restored", "Backup restored"),
    t("system.recovery.reopen", "Quit and reopen Cadencr to start from the restored database."),
    recovery.actions.filter((candidate) => candidate.id !== "restore_backup"),
  );
}
