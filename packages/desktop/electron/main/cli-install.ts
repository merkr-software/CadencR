import fs from "node:fs/promises";
import type { CliInstallOptions, CliInstallStatus } from "../../src/shared/cli-bridge";
import {
  appImageCliStatus,
  appImageInstallCli,
  appImageUninstallCli,
  refreshAppImageCli,
} from "./cli-install-appimage";
import { bundledCliPath, PACKAGE_CLI_PATH, type CliInstallContext } from "./cli-install-context";
import { errnoCode } from "./errno";
import { macCliStatus, macInstallCli, macUninstallCli } from "./cli-install-macos";

/** How the command reaches PATH on this install; `null` when it can't. */
type InstallKind = "macos" | "appimage" | "package";

type Resolution = { kind: InstallKind } | { kind: null; reason: string };

async function bundledCliExists(context: CliInstallContext): Promise<boolean> {
  try {
    await fs.access(bundledCliPath(context));
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * A mounted disk image, or the read-only copy macOS runs a quarantined app
 * from (App Translocation): both go away, and the command link with them.
 */
function isTemporaryMacLocation(resourcesPath: string): boolean {
  return resourcesPath.startsWith("/Volumes/") || resourcesPath.includes("/AppTranslocation/");
}

async function resolveInstallKind(context: CliInstallContext): Promise<Resolution> {
  if (!context.isPackaged) {
    return {
      kind: null,
      reason:
        "Development builds don't ship the cadencr command. From the repository, run it with: pnpm rust -- run -p cadencr-cli --",
    };
  }
  if (context.platform !== "darwin" && context.platform !== "linux") {
    return { kind: null, reason: "The cadencr command is available on macOS and Linux." };
  }
  if (context.platform === "linux") {
    if (context.linuxInstallType === "deb" || context.linuxInstallType === "rpm") {
      return { kind: "package" };
    }
    if (context.linuxInstallType === "unknown") {
      return {
        kind: null,
        reason:
          "This Linux build is not an official AppImage, DEB or RPM package, so it can't install the cadencr command.",
      };
    }
  }
  if (context.platform === "darwin" && isTemporaryMacLocation(context.resourcesPath)) {
    return {
      kind: null,
      reason:
        "Cadencr is running from a disk image or a temporary copy, so a link to it would break. Move Cadencr to Applications and open it from there to install the cadencr command.",
    };
  }
  if (!(await bundledCliExists(context))) {
    return { kind: null, reason: "This build of Cadencr does not include the cadencr command." };
  }
  return { kind: context.platform === "darwin" ? "macos" : "appimage" };
}

export async function cliInstallStatus(context: CliInstallContext): Promise<CliInstallStatus> {
  const resolution = await resolveInstallKind(context);
  switch (resolution.kind) {
    case null:
      return { state: "unavailable", reason: resolution.reason };
    case "package":
      return { state: "package", path: PACKAGE_CLI_PATH };
    case "macos":
      return macCliStatus(context);
    case "appimage":
      return appImageCliStatus(context);
  }
}

/** Installs (or reinstalls) the command; refuses to replace a foreign one unless asked. */
export async function installCli(
  context: CliInstallContext,
  { replace }: CliInstallOptions,
): Promise<CliInstallStatus> {
  const status = await cliInstallStatus(context);
  switch (status.state) {
    case "unavailable":
      throw new Error(status.reason);
    case "package":
      throw new Error(`The ${status.path} command comes with the Cadencr package already.`);
    case "conflict":
      if (!replace) {
        throw new Error(
          `${status.target} already exists (${status.existing}). Review it in Settings → General.`,
        );
      }
      break;
    case "not-installed":
    case "installed":
      break;
  }
  if (context.platform === "darwin") await macInstallCli(context);
  else await appImageInstallCli(context);
  return cliInstallStatus(context);
}

/** Removes the command, only when it is Cadencr's own. */
export async function uninstallCli(context: CliInstallContext): Promise<CliInstallStatus> {
  const status = await cliInstallStatus(context);
  if (status.state !== "installed") {
    throw new Error("The cadencr command was not installed by Cadencr, so it was left in place.");
  }
  if (context.platform === "darwin") await macUninstallCli(context);
  else await appImageUninstallCli(context);
  return cliInstallStatus(context);
}

/** Launch-time upkeep: only the AppImage's copied command can go stale. */
export async function refreshInstalledCli(context: CliInstallContext): Promise<void> {
  const resolution = await resolveInstallKind(context);
  if (resolution.kind === "appimage") await refreshAppImageCli(context);
}
