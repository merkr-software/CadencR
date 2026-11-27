import { translateUi } from "@/lib/i18n/ui";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { CliInstallStatus } from "@/shared/cli-bridge";
import { describeCliConflict, describeCliUnavailable } from "@/shared/cli-install-copy";

export const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "cli-install-status"] as const;

function directoryOf(target: string): string {
  return target.slice(0, target.lastIndexOf("/")) || "/";
}

/** One sentence on where the command stands. */
export function describeCliInstall(status: CliInstallStatus): string {
  switch (status.state) {
    case "unavailable":
      return describeCliUnavailable(status);
    case "package":
      return translateUi(
        "settings.general.commandLine.package",
        "Installed with the Cadencr package at {{path}}.",
        { path: status.path },
      );
    case "not-installed":
      return translateUi(
        "settings.general.commandLine.notInstalled",
        "Adds cadencr to {{directory}} to open files and projects, add projects, update Cadencr or run it headless from a terminal.",
        { directory: directoryOf(status.target) },
      );
    case "installed":
      return status.current
        ? translateUi("settings.general.commandLine.installed", "Installed at {{target}}.", {
            target: status.target,
          })
        : translateUi(
            "settings.general.commandLine.otherCopy",
            "{{target}} starts another copy of Cadencr. Reinstall it to use this one.",
            { target: status.target },
          );
    case "conflict":
      return translateUi(
        "settings.general.commandLine.conflict",
        "{{target}} already exists: {{existing}}. Replace it to use Cadencr's command.",
        { target: status.target, existing: describeCliConflict(status) },
      );
  }
}

/** The PATH warning a status calls for, if any. */
export function cliPathHint(status: CliInstallStatus): string | null {
  if (status.state !== "installed" && status.state !== "not-installed") return null;
  if (status.onPath) return null;
  return translateUi(
    "settings.general.commandLine.pathHint",
    "{{directory}} is not on this app's PATH. If your shell can't find cadencr, add it to your shell profile.",
    { directory: directoryOf(status.target) },
  );
}

/** After an install from Settings or the palette: cache the new status and say where it stands. */
export function reportCliInstalled(
  queryClient: QueryClient,
  status: CliInstallStatus,
  toastId?: string | number,
): void {
  queryClient.setQueryData(CLI_INSTALL_STATUS_QUERY_KEY, status);
  toast.success(describeCliInstall(status), {
    id: toastId,
    description: cliPathHint(status) ?? undefined,
  });
}

/**
 * The palette's install: installs, or explains why it can't. A foreign
 * `cadencr` is only ever replaced from Settings, after a confirmation.
 */
export async function installCliCommand(
  queryClient: QueryClient,
  openSettings: () => void,
): Promise<void> {
  const toastId = toast.loading(
    translateUi("palette.operations.installingCli", "Installing the cadencr command…"),
  );
  try {
    const current = await desktopBridge.cliInstallStatus();
    if (current.state === "conflict" || current.state === "unavailable") {
      toast.error(describeCliInstall(current), {
        id: toastId,
        action: {
          label: translateUi("palette.commands.go-settings.title", "Settings"),
          onClick: openSettings,
        },
      });
      return;
    }
    if (current.state === "package") {
      toast.info(describeCliInstall(current), { id: toastId });
      return;
    }
    reportCliInstalled(queryClient, await desktopBridge.installCli({ replace: false }), toastId);
  } catch (error) {
    toast.error(
      apiErrorMessage(
        error,
        translateUi("palette.operations.installCliError", "Couldn't install the cadencr command"),
      ),
      { id: toastId },
    );
  }
}
