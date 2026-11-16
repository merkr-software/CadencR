import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "./app-paths";
import { errnoCode } from "./errno";
import type { LinuxInstallType } from "./linux-install-type";

/** Everything the install logic reads from the running app, injectable for tests. */
export interface CliInstallContext {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** `app.getVersion()`: an AppImage update is what makes its copied command stale. */
  appVersion: string;
  /** `process.resourcesPath`: the bundled CLI is `<resources>/bin/cadencr`. */
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
  /**
   * Directories a login shell has on PATH whatever the app's own PATH says
   * (macOS `/etc/paths`): an app started from the Dock gets launchd's PATH,
   * which lacks `/usr/local/bin` although every Terminal has it.
   */
  loginPathDirs: readonly string[];
  homedir: string;
  linuxInstallType: LinuxInstallType;
  /** macOS: where the command link goes (`/usr/local/bin`). */
  macBinDir: string;
  /** macOS: runs `script` (an AppleScript `on run argv` handler) as administrator. */
  runPrivileged: (script: string, args: readonly string[]) => Promise<void>;
}

export const CLI_NAME = "cadencr";
/** Where the DEB and RPM packages link the command (see build/linux/after-install.tpl). */
export const PACKAGE_CLI_PATH = "/usr/bin/cadencr";
export const MAC_BIN_DIR = "/usr/local/bin";

export function bundledCliPath(context: Pick<CliInstallContext, "resourcesPath">): string {
  return path.join(context.resourcesPath, "bin", CLI_NAME);
}

/** AppImage: the user-level copy of the command, outside the transient mount. */
export function appImageTarget(context: Pick<CliInstallContext, "homedir">): string {
  return path.join(context.homedir, ".local", "bin", CLI_NAME);
}

/** AppImage: tells the copied command which AppImage to start (read by the CLI). */
export function cliLocatorPath(
  context: Pick<CliInstallContext, "platform" | "homedir" | "env">,
): string {
  return path.join(
    resolveConfigDir({ platform: context.platform, homedir: context.homedir, env: context.env }),
    "cli.json",
  );
}

/** Whether a shell finds commands in `dir`: on the app's `PATH` or a login shell's. */
export function isOnPath(
  context: Pick<CliInstallContext, "env" | "loginPathDirs">,
  dir: string,
): boolean {
  const entries = [
    ...(context.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...context.loginPathDirs,
  ];
  const wanted = path.resolve(dir);
  return entries.some((entry) => path.resolve(entry) === wanted);
}

/** `lstat` that answers `null` for a missing path and throws anything else. */
export async function lstatOrNull(
  target: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** SHA-256 of a file, streamed: the command is several megabytes. */
export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
