import { spawn, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { resolveConfigDir, resolveDatabasePath } from "./app-paths";
import { childProcessEnv } from "./child-env";
import { ensureLinuxSidecarExecutable } from "./sidecar-executable";
import { createStartupWatchdog, recordStartupProgress, waitForHealthy } from "./sidecar-health";
import { NEWER_DATABASE_RECOVERY_DETAIL, isNewerDatabaseStartupFailure } from "./startup-recovery";
import { sendShutdownIntent } from "./shutdown-intent";
import type { AppCloseChoice } from "../../src/shared/app-close";

export { ensureLinuxSidecarExecutable } from "./sidecar-executable";

const SIDECAR_PORT = 5004;
const DEFAULT_DEV_API_BASE_URL = "http://127.0.0.1:5005";
const STDERR_TAIL_LINES = 12;
const PHASE_PREFIX = "CADENCR_PHASE ";

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;

export type SidecarPhase =
  | "starting_service"
  | "waiting_for_service"
  | "backing_up"
  | "backup_failed"
  | "migrating"
  | "optimizing_storage"
  | "compacting_database"
  | "importing_usage"
  | "loading_app";

export interface SidecarStatusUpdate {
  phase: SidecarPhase;
  detail?: string;
}

export interface SidecarHandle {
  baseUrl: string;
  authToken: string | null;
  stop: () => Promise<void>;
  /**
   * Before `stop`: whether the agents it cuts off resume on the next start
   * (they do unless told otherwise). A no-op for the dev service, which
   * outlives the app.
   */
  setShutdownIntent: (choice: AppCloseChoice) => Promise<void>;
}

export interface BrowserBridgeSidecarEnv {
  url: string;
  token: string;
}

export interface SpawnProductionSidecarOptions {
  appVersion?: string;
  browserBridge?: BrowserBridgeSidecarEnv;
  onStatus?: (update: SidecarStatusUpdate) => void;
}

function normalizeBaseUrl(key: string, value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use http:// or https://`);
  }
  if (!parsed.hostname) throw new Error(`${key} must include a host`);
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error(`${key} must not include a path, query, or fragment`);
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}`;
}

export function createDevSidecarHandle(): SidecarHandle {
  const rawBaseUrl = process.env.VITE_API_URL ?? DEFAULT_DEV_API_BASE_URL;
  const authToken = process.env.VITE_API_TOKEN?.trim() || null;
  return {
    baseUrl: normalizeBaseUrl("VITE_API_URL", rawBaseUrl),
    authToken,
    stop: () => Promise.resolve(),
    setShutdownIntent: () => Promise.resolve(),
  };
}

/**
 * Turbo starts the dev service and Electron concurrently. A large copied
 * database can still be migrating when Electron becomes ready, so wait for the
 * authenticated health endpoint before any startup API call (including Browser
 * bridge registration). Production does this inside `spawnProductionSidecar`.
 */
export async function waitForDevSidecar(
  handle: SidecarHandle,
  onStatus: (update: SidecarStatusUpdate) => void = () => {},
): Promise<void> {
  if (!handle.authToken) {
    throw new Error("Cannot start Cadencr: development service auth token is missing.");
  }
  const watchdog = createStartupWatchdog();
  recordStartupProgress(watchdog, "waiting_for_service");
  onStatus({ phase: "waiting_for_service" });
  await waitForHealthy(handle.baseUrl, handle.authToken, () => false, watchdog);
  onStatus({ phase: "loading_app" });
}

export function productionDbPath(): string {
  const dbPath = resolveDatabasePath();
  const dir = path.dirname(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Cadencr can't initialize its data directory at ${dir}: ${cause}`);
  }
  return dbPath;
}

function productionBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "cadencr-service.exe" : "cadencr-service";
  return path.join(process.resourcesPath, binaryName);
}

/**
 * Absolute path to the built SPA on the real filesystem, copied via
 * `extraResources` (the renderer is excluded from the asar to avoid a
 * duplicate, and the Rust sidecar can't read an asar anyway). Shared by both
 * the packaged window (see `rendererLoadUrl`) and the sidecar's
 * `--renderer-dir` remote listener. Must match the electron-builder `to:
 * renderer` mapping.
 */
export function packagedRendererDir(): string {
  return path.join(process.resourcesPath, "renderer");
}

/**
 * `packagedRendererDir()` when it actually holds the SPA, else `null` — in
 * which case remote serving over the listener stays disabled.
 */
function productionRendererDir(): string | null {
  const dir = packagedRendererDir();
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

function generateAuthToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export async function spawnProductionSidecar(
  options: SpawnProductionSidecarOptions = {},
): Promise<SidecarHandle> {
  const baseUrl = `http://127.0.0.1:${SIDECAR_PORT}`;
  const authToken = generateAuthToken();
  const onStatus = options.onStatus ?? (() => {});
  const watchdog = createStartupWatchdog();
  const reportStatus = (update: SidecarStatusUpdate): void => {
    recordStartupProgress(watchdog, update.phase);
    onStatus(update);
  };

  await assertPortAvailable(SIDECAR_PORT);
  reportStatus({ phase: "starting_service" });

  const binary = productionBinaryPath();
  ensureLinuxSidecarExecutable(binary, process.platform);
  const child = spawnService(
    binary,
    productionDbPath(),
    authToken,
    options.appVersion,
    productionRendererDir(),
    options.browserBridge,
  );
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const stderrTail: string[] = [];

  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    console.info(`[cadencr-service] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  child.on("error", (error) => {
    exited = true;
    stderrTail.push(`Failed to start cadencr-service: ${error.message}`);
  });
  pumpLogs(child, reportStatus, stderrTail);

  try {
    await waitForHealthy(baseUrl, authToken, () => exited, watchdog);
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const failure = new Error(
      describeStartupFailure(baseMessage, stderrTail, exitCode, exitSignal),
    );
    return rethrowAfterCleanup(failure, () => stopChild(child));
  }
  reportStatus({ phase: "loading_app" });
  return {
    baseUrl,
    authToken,
    stop: () => stopChild(child),
    setShutdownIntent: (choice) => sendShutdownIntent(baseUrl, authToken, choice),
  };
}

/**
 * A sidecar that failed startup has not yet been returned to Electron, so no
 * global handle can stop it during app shutdown. Always finish cleanup before
 * surfacing the original failure; otherwise a timed-out migration can keep
 * running against the database as an orphaned process.
 */
export async function rethrowAfterCleanup(
  failure: Error,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new AggregateError(
      [failure, cleanupError],
      `${failure.message}\n\nFailed to stop the service after startup failure: ${detail}`,
    );
  }
  throw failure;
}

function spawnService(
  binary: string,
  dbPath: string,
  authToken: string,
  appVersion: string | undefined,
  rendererDir: string | null,
  browserBridge?: BrowserBridgeSidecarEnv,
): ServiceProcess {
  return spawn(binary, serviceArgs(dbPath, appVersion, rendererDir), {
    env: serviceEnv(authToken, browserBridge),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function serviceEnv(
  authToken: string,
  browserBridge?: BrowserBridgeSidecarEnv,
): NodeJS.ProcessEnv {
  return {
    ...childProcessEnv(process.env),
    CADENCR_AUTH_TOKEN: authToken,
    ...(browserBridge
      ? {
          CADENCR_BROWSER_BRIDGE_URL: browserBridge.url,
          CADENCR_BROWSER_BRIDGE_TOKEN: browserBridge.token,
        }
      : {}),
  };
}

export function serviceArgs(
  dbPath: string,
  appVersion?: string,
  rendererDir?: string | null,
): string[] {
  const settingsDir = resolveSettingsDir(dbPath);

  const args = ["--db-path", dbPath, "--settings-dir", settingsDir, "--port", String(SIDECAR_PORT)];
  if (appVersion) args.push("--app-version", appVersion);
  // Enables remote-access serving; the local window still loads file://.
  if (rendererDir) args.push("--renderer-dir", rendererDir);
  return args;
}

export function resolveSettingsDir(
  dbPath: string,
  platform: NodeJS.Platform = process.platform,
  configDir?: string,
): string {
  if (platform === "linux") {
    return path.join(configDir ?? resolveConfigDir(), "settings");
  }
  // Preserve the legacy macOS layout beside ~/.cadencr/database.
  return path.join(path.dirname(path.dirname(dbPath)), "settings");
}

export function describeStartupFailure(
  baseMessage: string,
  stderrTail: string[],
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
): string {
  if (stderrTail.some(isNewerDatabaseStartupFailure)) {
    return NEWER_DATABASE_RECOVERY_DETAIL;
  }

  const detail = describeServiceFailure(stderrTail, exitCode, exitSignal);
  return detail ? [baseMessage, detail].join("\n\n") : baseMessage;
}

function describeServiceFailure(
  stderrTail: string[],
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
): string {
  const parts: string[] = [];
  if (exitCode !== null || exitSignal !== null) {
    parts.push(`Service exit: code=${exitCode ?? "null"} signal=${exitSignal ?? "null"}.`);
  }
  if (stderrTail.length > 0) {
    parts.push("Last log lines:");
    parts.push(stderrTail.slice(-STDERR_TAIL_LINES).join("\n"));
  }
  return parts.join("\n");
}

async function assertPortAvailable(port: number): Promise<void> {
  const available = await isPortAvailable(port);
  if (!available) {
    throw new Error(`cadencr-service cannot start because 127.0.0.1:${port} is already in use.`);
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function pumpLogs(
  child: ServiceProcess,
  onStatus: (update: SidecarStatusUpdate) => void,
  stderrTail: string[],
): void {
  forwardStream(child.stdout, "info", (line) => {
    const phaseUpdate = parsePhaseLine(line);
    if (phaseUpdate) onStatus(phaseUpdate);
  });
  forwardStream(child.stderr, "warn", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES * 2) {
      stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
    }
  });
}

function forwardStream(
  stream: Readable,
  level: "info" | "warn",
  onLine: (line: string) => void,
): void {
  const log = level === "info" ? console.info : console.warn;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        log(`[cadencr-service] ${line}`);
        onLine(line);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      log(`[cadencr-service] ${buffer}`);
      onLine(buffer);
    }
  });
}

export function parsePhaseLine(line: string): SidecarStatusUpdate | null {
  if (!line.startsWith(PHASE_PREFIX)) return null;
  const rest = line.slice(PHASE_PREFIX.length).trim();
  const spaceIdx = rest.indexOf(" ");
  const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const detail = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
  switch (name) {
    case "backing_up":
      return { phase: "backing_up", detail: detail || undefined };
    case "backup_failed":
      return { phase: "backup_failed", detail: detail || undefined };
    case "migrating":
      return { phase: "migrating", detail: detail || undefined };
    case "optimizing_storage":
      return { phase: "optimizing_storage", detail: detail || undefined };
    case "compacting_database":
      return { phase: "compacting_database", detail: detail || undefined };
    case "importing_usage":
      return { phase: "importing_usage", detail: detail || undefined };
    default:
      return null;
  }
}

async function stopChild(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const termSent = child.kill("SIGTERM");
  if (!termSent && !(await waitForExit(child, 100))) {
    throw new Error("cadencr-service rejected SIGTERM and is still running");
  }
  if (await waitForExit(child, 2_000)) return;
  if (child.exitCode === null && child.signalCode === null) {
    const killSent = child.kill("SIGKILL");
    if (!killSent && !(await waitForExit(child, 100))) {
      throw new Error("cadencr-service rejected SIGKILL and is still running");
    }
  }
  if (!(await waitForExit(child, 2_000))) {
    throw new Error("cadencr-service did not exit after SIGKILL");
  }
}

function waitForExit(child: ServiceProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
