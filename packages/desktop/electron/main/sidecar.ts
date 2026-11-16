import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfigDir, resolveDatabasePath } from "./app-paths";
import { childProcessEnv } from "./child-env";
import { ensureLinuxSidecarExecutable } from "./sidecar-executable";
import { createStartupWatchdog, recordStartupProgress, waitForHealthy } from "./sidecar-health";
import { SIDECAR_BASE_URL, SIDECAR_PORT } from "./sidecar-port";
import {
  assertPortAvailable,
  describeServiceFailure,
  describeStartupFailure,
  pumpLogs,
  recordStderrLine,
  stopChild,
  type ServiceProcess,
  type SidecarStatusUpdate,
} from "./sidecar-process";
import { sendShutdownIntent } from "./shutdown-intent";
import type { AppCloseChoice } from "../../src/shared/app-close";

export { ensureLinuxSidecarExecutable } from "./sidecar-executable";
export { describeStartupFailure, parsePhaseLine } from "./sidecar-process";
export type { SidecarPhase, SidecarStatusUpdate } from "./sidecar-process";

const DEFAULT_DEV_API_BASE_URL = "http://127.0.0.1:5005";
/** Tells the service to shut down when its stdin closes (see `ServiceProcess`). */
export const EXIT_WITH_PARENT_FLAG = "--exit-with-parent";

/** How a running service ended without Electron asking it to. */
export interface SidecarExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Exit status and the last stderr lines, for the user. */
  detail: string;
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
  /** The service exited after startup while nobody had asked it to stop. */
  onUnexpectedExit?: (exit: SidecarExit) => void;
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
  const baseUrl = SIDECAR_BASE_URL;
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
  const watch = watchServiceProcess(child);
  pumpLogs(child, reportStatus, watch.stderrTail);

  try {
    await waitForHealthy(baseUrl, authToken, () => watch.exited, watchdog);
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const failure = new Error(
      describeStartupFailure(baseMessage, watch.stderrTail, watch.exitCode, watch.exitSignal),
    );
    return rethrowAfterCleanup(failure, () => stopChild(child));
  }
  reportStatus({ phase: "loading_app" });
  let stopRequested = false;
  superviseServiceProcess(child, watch, () => stopRequested, options.onUnexpectedExit);
  return {
    baseUrl,
    authToken,
    stop: () => {
      stopRequested = true;
      return stopChild(child);
    },
    setShutdownIntent: (choice) => sendShutdownIntent(baseUrl, authToken, choice),
  };
}

export interface ServiceProcessWatch {
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderrTail: string[];
}

function watchServiceProcess(child: ServiceProcess): ServiceProcessWatch {
  const watch: ServiceProcessWatch = {
    exited: false,
    exitCode: null,
    exitSignal: null,
    stderrTail: [],
  };
  child.on("exit", (code, signal) => {
    watch.exited = true;
    watch.exitCode = code;
    watch.exitSignal = signal;
    console.info(`[cadencr-service] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  child.on("error", (error) => {
    watch.exited = true;
    recordStderrLine(watch.stderrTail, `Failed to start cadencr-service: ${error.message}`);
  });
  // Nothing is ever written, so an error here only means the service end of
  // the pipe is gone: the exit that follows is what gets reported.
  child.stdin.on("error", (error) => {
    recordStderrLine(watch.stderrTail, `Service stdin closed: ${error.message}`);
  });
  return watch;
}

/**
 * Past startup, an exit nobody asked for is reported once, with what the
 * service last printed, so the window can offer a restart.
 */
export function superviseServiceProcess(
  child: Pick<ServiceProcess, "once">,
  watch: ServiceProcessWatch,
  stopRequested: () => boolean,
  onUnexpectedExit: ((exit: SidecarExit) => void) | undefined,
): void {
  if (!onUnexpectedExit) return;
  const report = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopRequested()) return;
    onUnexpectedExit({
      code,
      signal,
      detail: describeServiceFailure(watch.stderrTail, code, signal),
    });
  };
  // It can die between the health check and this listener.
  if (watch.exited) {
    report(watch.exitCode, watch.exitSignal);
    return;
  }
  child.once("exit", report);
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
    stdio: ["pipe", "pipe", "pipe"],
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

  const args = [
    "--db-path",
    dbPath,
    "--settings-dir",
    settingsDir,
    "--port",
    String(SIDECAR_PORT),
    EXIT_WITH_PARENT_FLAG,
  ];
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
