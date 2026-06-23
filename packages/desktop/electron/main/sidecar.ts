import { spawn, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { NEWER_DATABASE_RECOVERY_DETAIL, isNewerDatabaseStartupFailure } from "./startup-recovery";

const SIDECAR_PORT = 5004;
const HEALTH_RETRIES = 60;
const HEALTH_INTERVAL_MS = 500;
const DEFAULT_DEV_API_BASE_URL = "http://127.0.0.1:5005";
const STDERR_TAIL_LINES = 12;
const PHASE_PREFIX = "CADENCR_PHASE ";

interface HealthBody {
  service?: string;
}

type ServiceProcess = ChildProcessByStdio<null, Readable, Readable>;

export type SidecarPhase =
  | "starting_service"
  | "backing_up"
  | "backup_failed"
  | "migrating"
  | "loading_app";

export interface SidecarStatusUpdate {
  phase: SidecarPhase;
  detail?: string;
}

export interface SidecarHandle {
  baseUrl: string;
  authToken: string | null;
  stop: () => Promise<void>;
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
  };
}

export function productionDbPath(): string {
  const dbPath = path.join(os.homedir(), ".cadencr", "database", "cadencr.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

function productionBinaryPath(): string {
  const binaryName = process.platform === "win32" ? "cadencr-service.exe" : "cadencr-service";
  return path.join(process.resourcesPath, binaryName);
}

/**
 * Built SPA directory on the real filesystem (copied via `extraResources`), so
 * the service can serve it over the remote listener. The window itself still
 * loads the asar copy — this is the readable mirror for the Rust process.
 * `null` if it's somehow missing, in which case remote serving stays disabled.
 */
function productionRendererDir(): string | null {
  const dir = path.join(process.resourcesPath, "renderer");
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

  await assertPortAvailable(SIDECAR_PORT);
  onStatus({ phase: "starting_service" });

  const child = spawnService(
    productionBinaryPath(),
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
  pumpLogs(child, onStatus, stderrTail);

  try {
    await waitForHealthy(baseUrl, authToken, () => exited);
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    throw new Error(describeStartupFailure(baseMessage, stderrTail, exitCode, exitSignal));
  }
  onStatus({ phase: "loading_app" });
  return {
    baseUrl,
    authToken,
    stop: () => stopChild(child),
  };
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
    ...process.env,
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
  // Settings JSON files live alongside the database under ~/.cadencr/settings
  // (sibling of database/). Pass it explicitly so the service doesn't re-derive
  // the layout; the service creates the dir on startup.
  const settingsDir = path.join(path.dirname(path.dirname(dbPath)), "settings");

  const args = ["--db-path", dbPath, "--settings-dir", settingsDir, "--port", String(SIDECAR_PORT)];
  if (appVersion) args.push("--app-version", appVersion);
  // Lets the service serve the SPA over the remote-access listener. Loopback
  // (the local window) loads from file:// regardless, so this only enables the
  // network path.
  if (rendererDir) args.push("--renderer-dir", rendererDir);
  return args;
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
    default:
      return null;
  }
}

async function stopChild(child: ServiceProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await waitForExit(child, 2_000);
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

async function waitForHealthy(
  baseUrl: string,
  authToken: string,
  hasExited: () => boolean,
): Promise<void> {
  const url = `${baseUrl}/api/health`;
  for (let retry = 0; retry < HEALTH_RETRIES; retry++) {
    if (hasExited()) {
      throw new Error(`cadencr-service exited before passing health check at ${baseUrl}`);
    }
    if (await probeHealth(url, authToken, retry)) return;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  throw new Error(`Health check failed after ${HEALTH_RETRIES} retries at ${baseUrl}`);
}

async function probeHealth(url: string, authToken: string, retry: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { "x-cadencr-token": authToken },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as HealthBody;
    if (body.service !== "cadencr") {
      throw new Error(`Health responder identified itself as '${body.service ?? ""}'`);
    }
    console.info(`Health check passed after ${retry} retries`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Health responder")) throw error;
    return false;
  }
}
