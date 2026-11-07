import type { ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { NEWER_DATABASE_RECOVERY_DETAIL, isNewerDatabaseStartupFailure } from "./startup-recovery";

const STDERR_TAIL_LINES = 12;
const PHASE_PREFIX = "CADENCR_PHASE ";

/**
 * The packaged service. Its stdin is a pipe Electron never writes to: the
 * service treats end-of-file on it as "the desktop shell is gone" (see
 * `--exit-with-parent`), which holds however Electron exits, crash included.
 */
export type ServiceProcess = ChildProcessByStdio<Writable, Readable, Readable>;

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

export function describeServiceFailure(
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

export async function assertPortAvailable(port: number): Promise<void> {
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

export function pumpLogs(
  child: ServiceProcess,
  onStatus: (update: SidecarStatusUpdate) => void,
  stderrTail: string[],
): void {
  forwardStream(child.stdout, "info", (line) => {
    const phaseUpdate = parsePhaseLine(line);
    if (phaseUpdate) onStatus(phaseUpdate);
  });
  forwardStream(child.stderr, "warn", (line) => recordStderrLine(stderrTail, line));
}

export function recordStderrLine(stderrTail: string[], line: string): void {
  stderrTail.push(line);
  if (stderrTail.length > STDERR_TAIL_LINES * 2) {
    stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
  }
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

export async function stopChild(child: ServiceProcess): Promise<void> {
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
