import type { CliInstallConflict, CliInstallStatus, CliInstallUnavailableCode } from "./cli-bridge";
import { translateUi as t } from "./ui-i18n";

type UnavailableStatus = Extract<CliInstallStatus, { state: "unavailable" }>;
type ConflictStatus = Extract<CliInstallStatus, { state: "conflict" }>;

function unavailableText(code: CliInstallUnavailableCode): string {
  switch (code) {
    case "development":
      return t(
        "settings.general.commandLine.development",
        "Development builds don't ship the cadencr command. From the repository, run it with: {{command}}",
        { command: "pnpm rust -- run -p cadencr-cli --" },
      );
    case "unsupported-platform":
      return t(
        "settings.general.commandLine.unsupportedPlatform",
        "The cadencr command is available on macOS and Linux.",
      );
    case "unofficial-linux-package":
      return t(
        "settings.general.commandLine.unofficialLinuxPackage",
        "This Linux build is not an official AppImage, DEB or RPM package, so it can't install the cadencr command.",
      );
    case "temporary-macos-location":
      return t(
        "settings.general.commandLine.temporaryMacLocation",
        "Cadencr is running from a disk image or a temporary copy, so a link to it would break. Move Cadencr to Applications and open it from there to install the cadencr command.",
      );
    case "missing-command":
      return t(
        "settings.general.commandLine.missingCommand",
        "This build of Cadencr does not include the cadencr command.",
      );
    case "desktop-required":
      return t(
        "settings.general.cli.desktopRequired",
        "The cadencr command is installed from the desktop app.",
      );
  }
}

function conflictText(conflict: CliInstallConflict): string {
  switch (conflict.kind) {
    case "link":
      return t("settings.general.commandLine.conflictLink", "a link to {{path}}", {
        path: conflict.path,
      });
    case "unmanaged-program":
      return t(
        "settings.general.commandLine.conflictUnmanaged",
        "a program not installed by Cadencr",
      );
    case "replaced-program":
      return t(
        "settings.general.commandLine.conflictReplaced",
        "a program that replaced Cadencr's",
      );
  }
}

export function unavailableCliStatus(code: CliInstallUnavailableCode): UnavailableStatus {
  return { state: "unavailable", code, reason: unavailableText(code) };
}

export function conflictCliStatus(
  target: string,
  onPath: boolean,
  conflict: CliInstallConflict,
): ConflictStatus {
  return { state: "conflict", target, onPath, conflict, existing: conflictText(conflict) };
}

export function describeCliUnavailable(status: UnavailableStatus): string {
  return status.code ? unavailableText(status.code) : status.reason;
}

export function describeCliConflict(status: ConflictStatus): string {
  return status.conflict ? conflictText(status.conflict) : status.existing;
}
