import { translateUi } from "@/lib/i18n/ui";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { CliInstallStatus } from "@/shared/cli-bridge";

export const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "cli-install-status"] as const;

function directoryOf(target: string): string {
  return target.slice(0, target.lastIndexOf("/")) || "/";
}

function unavailableDescription(
  status: Extract<CliInstallStatus, { state: "unavailable" }>,
): string {
  switch (status.code) {
    case "development":
      return translateUi(
        "settings.general.commandLine.development",
        "Development builds don't ship the cadencr command. From the repository, run it with: {{command}}",
        { command: "pnpm rust -- run -p cadencr-cli --" },
      );
    case "unsupported-platform":
      return translateUi(
        "settings.general.commandLine.unsupportedPlatform",
        "The cadencr command is available on macOS and Linux.",
      );
    case "unofficial-linux-package":
      return translateUi(
        "settings.general.commandLine.unofficialLinuxPackage",
        "This Linux build is not an official AppImage, DEB or RPM package, so it can't install the cadencr command.",
      );
    case "temporary-macos-location":
      return translateUi(
        "settings.general.commandLine.temporaryMacLocation",
        "Cadencr is running from a disk image or a temporary copy, so a link to it would break. Move Cadencr to Applications and open it from there to install the cadencr command.",
      );
    case "missing-command":
      return translateUi(
        "settings.general.commandLine.missingCommand",
        "This build of Cadencr does not include the cadencr command.",
      );
    default:
      return status.reason;
  }
}

export function describeCliConflict(
  status: Extract<CliInstallStatus, { state: "conflict" }>,
): string {
  switch (status.conflict?.kind) {
    case "link":
      return translateUi("settings.general.commandLine.conflictLink", "a link to {{path}}", {
        path: status.conflict.path,
      });
    case "unmanaged-program":
      return translateUi(
        "settings.general.commandLine.conflictUnmanaged",
        "a program not installed by Cadencr",
      );
    case "replaced-program":
      return translateUi(
        "settings.general.commandLine.conflictReplaced",
        "a program that replaced Cadencr's",
      );
    default:
      return status.existing;
  }
}

/** One sentence on where the command stands. */
export function describeCliInstall(status: CliInstallStatus): string {
  switch (status.state) {
    case "unavailable":
      return unavailableDescription(status);
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
