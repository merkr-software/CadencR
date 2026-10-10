import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ENV,
  SERVICE_ENV,
  portMismatches,
  readEnvFile,
  updateEnvFile,
  urlPort,
  validPort,
} from "./dev-env.mjs";
import { gitCheckout, listGitWorktrees } from "./git-worktrees.mts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

// The service runs from its package dir, so a relative CADENCR_DB_PATH resolves there.
const SERVICE_DIR = join("packages", "service");
const DEV_DATABASE = join(SERVICE_DIR, "cadencr.local.db");

interface PortAssignment {
  frontendPort: number;
  servicePort: number;
  remotePort: number;
}

interface WorktreeDevResult extends PortAssignment {
  /** Whether CADENCR_DEV_SKIP_DB_BACKUP=1 was written (see `usesFreshClone`). */
  skipDbBackup: boolean;
}

interface CheckoutDevConfig {
  profileSuffix: string | undefined;
  portsAgree: boolean;
  frontendPort: number | null;
  apiPort: number | null;
  serviceFrontendPort: number | null;
  servicePort: number | null;
  remotePort: number | null;
}

interface ConfigureWorktreeDevOptions {
  currentRoot: string;
  mainRoot: string;
  worktreeRoots: string[];
  lockPath: string;
  listeningPorts?: ReadonlySet<number>;
}

interface ChooseAssignmentOptions {
  currentRoot: string;
  worktreeRoots: string[];
  listeningPorts: ReadonlySet<number>;
}

function readDevConfig(root: string): CheckoutDevConfig {
  const desktop = readEnvFile(root, DESKTOP_ENV) ?? {};
  const service = readEnvFile(root, SERVICE_ENV) ?? {};
  return {
    profileSuffix: desktop.CADENCR_DEV_USER_DATA_SUFFIX,
    portsAgree: portMismatches(service, desktop).length === 0,
    frontendPort: validPort(desktop.VITE_FRONTEND_PORT),
    apiPort: urlPort(desktop.VITE_API_URL),
    serviceFrontendPort: validPort(service.CADENCR_FRONTEND_PORT),
    servicePort: validPort(service.CADENCR_RUST_PORT),
    remotePort: validPort(service.CADENCR_REMOTE_PORT),
  };
}

function assignmentFromConfig(root: string, config: CheckoutDevConfig): PortAssignment | null {
  const { frontendPort, servicePort, remotePort } = config;
  if (
    config.profileSuffix !== basename(root) ||
    frontendPort === null ||
    servicePort === null ||
    remotePort === null ||
    !config.portsAgree
  ) {
    return null;
  }
  return { frontendPort, servicePort, remotePort };
}

function reservePorts(root: string, reserved: Set<number>): void {
  const { frontendPort, apiPort, serviceFrontendPort, servicePort, remotePort } =
    readDevConfig(root);
  for (const port of [frontendPort, apiPort, serviceFrontendPort, servicePort, remotePort]) {
    if (port !== null) reserved.add(port);
  }
}

export function parseListeningPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^n.*:(\d+)$/);
    const port = validPort(match?.[1]);
    if (port !== null) ports.add(port);
  }
  return ports;
}

function listeningPorts(): Set<number> {
  const command = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const result = spawnSync(command, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error("lsof failed while listing listening TCP ports");
  }
  return parseListeningPorts(result.stdout);
}

function nextPort(start: number, reserved: Set<number>, listening: ReadonlySet<number>): number {
  for (let port = start; port <= 65535; port += 1) {
    if (reserved.has(port) || listening.has(port)) continue;
    reserved.add(port);
    return port;
  }
  throw new Error(`No free TCP port available from ${start}`);
}

/**
 * Copy `source` to `target` as a copy-on-write clone when the filesystem
 * supports it, so a multi-GB dev database shares its blocks with the main
 * checkout until either side writes. Node's FICLONE flag is a no-op on macOS
 * (libuv never calls clonefile), so APFS goes through `cp -c`; elsewhere
 * FICLONE reflinks on btrfs/XFS and silently falls back to a plain copy.
 */
export function cloneOrCopy(source: string, target: string, platform = process.platform): void {
  if (platform === "darwin") {
    const result = spawnSync("cp", ["-c", source, target], { encoding: "utf8" });
    if (result.status === 0) return;
    console.warn(
      `copy-on-write clone failed (${result.stderr?.trim() || result.error?.message}); copying ${source} instead`,
    );
  }
  copyFileSync(source, target, fsConstants.COPYFILE_FICLONE);
}

/** Copy the main checkout's `.env` files; returns whether it cloned the database. */
function copyBaseFiles(mainRoot: string, currentRoot: string): boolean {
  for (const envPath of [DESKTOP_ENV, SERVICE_ENV]) {
    if (!existsSync(join(mainRoot, envPath))) {
      throw new Error(
        `Missing main-checkout file: ${join(mainRoot, envPath)} (run \`pnpm setup:dev\` in the main checkout)`,
      );
    }
    copyFileSync(join(mainRoot, envPath), join(currentRoot, envPath));
  }
  // The repo-root .env is a legacy token file; nothing requires it anymore.
  if (existsSync(join(mainRoot, ".env"))) {
    copyFileSync(join(mainRoot, ".env"), join(currentRoot, ".env"));
  }
  // Seed the worktree with the main checkout's dev data when there is any. A
  // main checkout that never ran the service has none; the worktree's service
  // then creates its own database on first launch. An existing worktree
  // database is never replaced.
  const source = join(mainRoot, DEV_DATABASE);
  const target = join(currentRoot, DEV_DATABASE);
  if (existsSync(target) || !existsSync(source)) return false;
  cloneOrCopy(source, target);
  return true;
}

/**
 * Whether the worktree service opens the database this run just cloned. Only
 * then is a pre-migration backup redundant: the main checkout still holds the
 * same data. A database the worktree already had holds data of its own, and a
 * custom CADENCR_DB_PATH copied from the main checkout may name a shared
 * database; both keep their backups.
 */
function usesFreshClone(currentRoot: string, clonedDatabase: boolean): boolean {
  const dbPath = readEnvFile(currentRoot, SERVICE_ENV)?.CADENCR_DB_PATH?.trim();
  if (!clonedDatabase || !dbPath) return false;
  return resolve(currentRoot, SERVICE_DIR, dbPath) === join(currentRoot, DEV_DATABASE);
}

async function acquireLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${lockPath}; remove it if no setup process is running`,
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

function chooseAssignment({
  currentRoot,
  worktreeRoots,
  listeningPorts,
}: ChooseAssignmentOptions): PortAssignment {
  const reserved = new Set<number>();
  for (const root of worktreeRoots) {
    if (resolve(root) !== currentRoot) reservePorts(root, reserved);
  }
  const previous = assignmentFromConfig(currentRoot, readDevConfig(currentRoot));
  if (
    previous &&
    !reserved.has(previous.frontendPort) &&
    !reserved.has(previous.servicePort) &&
    !reserved.has(previous.remotePort)
  ) {
    return previous;
  }
  return {
    frontendPort: nextPort(1421, reserved, listeningPorts),
    servicePort: nextPort(5100, reserved, listeningPorts),
    remotePort: nextPort(6100, reserved, listeningPorts),
  };
}

function writeAssignment(
  currentRoot: string,
  assignment: PortAssignment,
  skipDbBackup: boolean,
): void {
  updateEnvFile(currentRoot, DESKTOP_ENV, {
    VITE_FRONTEND_PORT: assignment.frontendPort,
    VITE_API_URL: `http://127.0.0.1:${assignment.servicePort}`,
    CADENCR_DEV_USER_DATA_SUFFIX: basename(currentRoot),
  });
  updateEnvFile(currentRoot, SERVICE_ENV, {
    CADENCR_FRONTEND_PORT: assignment.frontendPort,
    CADENCR_RUST_PORT: assignment.servicePort,
    CADENCR_REMOTE_PORT: assignment.remotePort,
    // A fresh copy-on-write clone of the main checkout's database: a
    // pre-migration snapshot would be a full, unshared multi-GB copy of data
    // the main checkout still holds. Removed in every other case.
    CADENCR_DEV_SKIP_DB_BACKUP: skipDbBackup ? 1 : undefined,
  });
}

export async function configureWorktreeDev({
  currentRoot,
  mainRoot,
  worktreeRoots,
  lockPath,
  listeningPorts: activeListeningPorts,
}: ConfigureWorktreeDevOptions): Promise<WorktreeDevResult> {
  currentRoot = resolve(currentRoot);
  mainRoot = resolve(mainRoot);
  const knownRoots = worktreeRoots.map((root) => resolve(root));
  if (currentRoot === mainRoot) {
    throw new Error(
      "dev:configure-worktree must run from a linked worktree, not the main checkout",
    );
  }
  if (!knownRoots.includes(currentRoot)) {
    throw new Error(`Current checkout is not registered as a Git worktree: ${currentRoot}`);
  }
  activeListeningPorts ??= listeningPorts();

  const releaseLock = await acquireLock(lockPath);
  try {
    const assignment = chooseAssignment({
      currentRoot,
      worktreeRoots: knownRoots,
      listeningPorts: activeListeningPorts,
    });
    const skipDbBackup = usesFreshClone(currentRoot, copyBaseFiles(mainRoot, currentRoot));
    writeAssignment(currentRoot, assignment, skipDbBackup);
    return { ...assignment, skipDbBackup };
  } finally {
    releaseLock();
  }
}

async function main(): Promise<void> {
  const { commonDir, linkedWorktree } = gitCheckout(repoRoot);
  if (!linkedWorktree) {
    throw new Error("dev:configure-worktree must run from a linked worktree; use `pnpm setup:dev`");
  }
  const mainRoot = dirname(commonDir);
  const result = await configureWorktreeDev({
    currentRoot: realpathSync(repoRoot),
    mainRoot: realpathSync(mainRoot),
    worktreeRoots: listGitWorktrees(repoRoot),
    lockPath: join(commonDir, "cadencr-dev-port-allocation.lock"),
  });
  console.log("Configured worktree development endpoints:");
  console.log(`  renderer: http://127.0.0.1:${result.frontendPort}`);
  console.log(`  service:  http://127.0.0.1:${result.servicePort}`);
  console.log(`  remote port: ${result.remotePort}`);
  console.log(`  profile:  ${basename(repoRoot)}`);
  console.log(
    result.skipDbBackup
      ? "  database: fresh clone of the main checkout's; pre-migration backups skipped"
      : "  database: pre-migration backups kept",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
