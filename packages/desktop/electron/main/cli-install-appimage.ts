import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CliInstallStatus } from "../../src/shared/cli-bridge";
import {
  appImageTarget,
  bundledCliPath,
  cliLocatorPath,
  fileSha256,
  isOnPath,
  lstatOrNull,
  type CliInstallContext,
} from "./cli-install-context";
import { errnoCode } from "./errno";

/**
 * The AppImage's command is a copy (its mount disappears when the app quits),
 * so the CLI learns from this file which AppImage to start: `version` and
 * `appimage` are the contract shared with `packages/cli`. The app also records
 * which release it copied (`appVersion`) and the copy's SHA-256, so a launch
 * refreshes the copy only after an update, and never replaces or removes a
 * `cadencr` someone else put there since.
 */
const locatorSchema = z.object({
  version: z.literal(1),
  appimage: z.string().min(1),
  appVersion: z.string().optional(),
  sha256: z.string().optional(),
});
type CliLocator = z.infer<typeof locatorSchema>;

async function readLocator(file: string): Promise<CliLocator | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} is not valid JSON: ${detail}`);
  }
  const parsed = locatorSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${file} is not a Cadencr command locator.`);
  return parsed.data;
}

function currentAppImage(context: CliInstallContext): string {
  const appImage = context.env.APPIMAGE;
  if (!appImage || !path.isAbsolute(appImage)) {
    throw new Error("Cadencr can't tell where its AppImage is: APPIMAGE is not set.");
  }
  return appImage;
}

async function writeAtomically(target: string, write: (temp: string) => Promise<void>) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await write(temp);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/** Copies the bundled command to the user's bin and records what was copied. */
async function installCopy(context: CliInstallContext): Promise<void> {
  const target = appImageTarget(context);
  await writeAtomically(target, async (temp) => {
    await fs.copyFile(bundledCliPath(context), temp);
    await fs.chmod(temp, 0o755);
  });
  const locator: CliLocator = {
    version: 1,
    appimage: currentAppImage(context),
    appVersion: context.appVersion,
    sha256: await fileSha256(target),
  };
  await writeAtomically(cliLocatorPath(context), (temp) =>
    fs.writeFile(temp, `${JSON.stringify(locator, null, 2)}\n`, { mode: 0o644 }),
  );
}

/** Whether the file at the target is still the copy the locator recorded. */
async function stillOurCopy(target: string, locator: CliLocator): Promise<boolean> {
  return locator.sha256 === undefined || (await fileSha256(target)) === locator.sha256;
}

export async function appImageCliStatus(context: CliInstallContext): Promise<CliInstallStatus> {
  const target = appImageTarget(context);
  const onPath = isOnPath(context, path.dirname(target));
  if (!(await lstatOrNull(target))) return { state: "not-installed", target, onPath };
  const locator = await readLocator(cliLocatorPath(context));
  if (!locator) {
    return { state: "conflict", target, existing: "a program not installed by Cadencr", onPath };
  }
  if (!(await stillOurCopy(target, locator))) {
    return { state: "conflict", target, existing: "a program that replaced Cadencr's", onPath };
  }
  const current =
    locator.appimage === context.env.APPIMAGE && locator.appVersion === context.appVersion;
  return { state: "installed", target, onPath, current };
}

export async function appImageInstallCli(context: CliInstallContext): Promise<void> {
  currentAppImage(context);
  await installCopy(context);
}

export async function appImageUninstallCli(context: CliInstallContext): Promise<void> {
  await fs.rm(appImageTarget(context), { force: true });
  await fs.rm(cliLocatorPath(context), { force: true });
}

/**
 * At launch: an AppImage update replaces the app, not the copied command, and
 * the AppImage itself may have moved. Brings the copy up to date when the user
 * installed it and nothing changed since; reads only the locator otherwise.
 */
export async function refreshAppImageCli(context: CliInstallContext): Promise<void> {
  const locator = await readLocator(cliLocatorPath(context));
  if (!locator) return;
  if (locator.appimage === currentAppImage(context) && locator.appVersion === context.appVersion) {
    return;
  }
  const target = appImageTarget(context);
  if (!(await lstatOrNull(target))) return;
  // Replaced since: Settings shows it as a conflict; a launch never overwrites it.
  if (!(await stillOurCopy(target, locator))) return;
  await installCopy(context);
}
