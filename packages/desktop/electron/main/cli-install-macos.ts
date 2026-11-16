import fs from "node:fs/promises";
import path from "node:path";
import type { CliInstallStatus } from "../../src/shared/cli-bridge";
import {
  bundledCliPath,
  CLI_NAME,
  isOnPath,
  lstatOrNull,
  type CliInstallContext,
} from "./cli-install-context";
import { errnoCode } from "./errno";

/** A command link into some copy of Cadencr.app (this one or another). */
const CADENCR_APP_CLI = /\.app\/Contents\/Resources\/bin\/cadencr$/;

/**
 * AppleScript run as administrator when `/usr/local/bin` is not writable. The
 * paths travel as `argv` and are quoted by AppleScript itself, so nothing from
 * them is ever spliced into the script text.
 */
const PRIVILEGED_LINK_SCRIPT = [
  "on run argv",
  'do shell script "/bin/mkdir -p " & quoted form of (item 3 of argv) & " && /bin/ln -sfn " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) with administrator privileges',
  "end run",
].join("\n");

const PRIVILEGED_REMOVE_SCRIPT = [
  "on run argv",
  'do shell script "/bin/rm -f " & quoted form of (item 1 of argv) with administrator privileges',
  "end run",
].join("\n");

function macTarget(context: CliInstallContext): string {
  return path.join(context.macBinDir, CLI_NAME);
}

export async function macCliStatus(context: CliInstallContext): Promise<CliInstallStatus> {
  const target = macTarget(context);
  const onPath = isOnPath(context, context.macBinDir);
  const stats = await lstatOrNull(target);
  if (!stats) return { state: "not-installed", target, onPath };
  if (!stats.isSymbolicLink()) {
    return { state: "conflict", target, existing: "a program not installed by Cadencr", onPath };
  }
  const linked = path.resolve(context.macBinDir, await fs.readlink(target));
  if (linked === bundledCliPath(context)) {
    return { state: "installed", target, onPath, current: true };
  }
  if (CADENCR_APP_CLI.test(linked)) return { state: "installed", target, onPath, current: false };
  return { state: "conflict", target, existing: `a link to ${linked}`, onPath };
}

function needsPrivileges(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "EACCES" || code === "EPERM";
}

export async function macInstallCli(context: CliInstallContext): Promise<void> {
  const source = bundledCliPath(context);
  const target = macTarget(context);
  try {
    await fs.mkdir(context.macBinDir, { recursive: true });
    await fs.rm(target, { force: true });
    await fs.symlink(source, target);
  } catch (error) {
    if (!needsPrivileges(error)) throw error;
    await context.runPrivileged(PRIVILEGED_LINK_SCRIPT, [source, target, context.macBinDir]);
  }
}

export async function macUninstallCli(context: CliInstallContext): Promise<void> {
  const target = macTarget(context);
  try {
    await fs.rm(target, { force: true });
  } catch (error) {
    if (!needsPrivileges(error)) throw error;
    await context.runPrivileged(PRIVILEGED_REMOVE_SCRIPT, [target]);
  }
}
