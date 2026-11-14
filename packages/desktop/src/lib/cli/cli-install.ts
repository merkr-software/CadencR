import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { CliInstallStatus } from "@/shared/cli-bridge";

export const CLI_INSTALL_STATUS_QUERY_KEY = ["desktop", "cli-install-status"] as const;

function directoryOf(target: string): string {
  return target.slice(0, target.lastIndexOf("/")) || "/";
}

/** One sentence on where the command stands. */
export function describeCliInstall(status: CliInstallStatus): string {
  switch (status.state) {
    case "unavailable":
      return status.reason;
    case "package":
      return `Installed with the Cadencr package at ${status.path}.`;
    case "not-installed":
      return `Adds cadencr to ${directoryOf(status.target)} to open files and projects, add projects, update Cadencr or run it headless from a terminal.`;
    case "installed":
      return status.current
        ? `Installed at ${status.target}.`
        : `${status.target} starts another copy of Cadencr. Reinstall it to use this one.`;
    case "conflict":
      return `${status.target} already exists: ${status.existing}. Replace it to use Cadencr's command.`;
  }
}

/** The PATH warning a status calls for, if any. */
export function cliPathHint(status: CliInstallStatus): string | null {
  if (status.state !== "installed" && status.state !== "not-installed") return null;
  if (status.onPath) return null;
  return `${directoryOf(status.target)} is not on this app's PATH. If your shell can't find cadencr, add it to your shell profile.`;
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
  const toastId = toast.loading("Installing the cadencr command…");
  try {
    const current = await desktopBridge.cliInstallStatus();
    if (current.state === "conflict" || current.state === "unavailable") {
      toast.error(describeCliInstall(current), {
        id: toastId,
        action: { label: "Settings", onClick: openSettings },
      });
      return;
    }
    if (current.state === "package") {
      toast.info(describeCliInstall(current), { id: toastId });
      return;
    }
    reportCliInstalled(queryClient, await desktopBridge.installCli({ replace: false }), toastId);
  } catch (error) {
    toast.error(apiErrorMessage(error, "Couldn't install the cadencr command"), { id: toastId });
  }
}
