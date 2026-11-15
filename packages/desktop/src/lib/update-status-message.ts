import type { UpdateStatus } from "@/shared/update-state";

/** One line on where an update check stands (Settings → About, `cadencr update`). */
export function updateStatusMessage(
  status: UpdateStatus,
  detail: {
    progress: number;
    version: string | null;
    error: string | null;
    unsupportedMessage: string | null;
  },
): string {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading update${detail.version ? ` v${detail.version}` : ""}… ${Math.round(detail.progress)}%`;
    case "downloaded":
      return `Update v${detail.version ?? ""} ready. Restart to install.`;
    case "up-to-date":
      return "You're on the latest version.";
    case "available":
      return `Update v${detail.version ?? ""} available.`;
    case "error":
      return detail.error ? `Update check failed: ${detail.error}` : "Update check failed.";
    case "unsupported":
      return detail.unsupportedMessage ?? "In-app updates are unavailable for this install.";
    case "idle":
    default:
      return "";
  }
}
