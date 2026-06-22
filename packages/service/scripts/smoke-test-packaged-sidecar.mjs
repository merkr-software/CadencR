#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const root = path.resolve(import.meta.dirname, "../../..");
const binaryName = process.platform === "win32" ? "cadencr-service.exe" : "cadencr-service";
const defaultBinary = path.join(root, "packages", "desktop", "resources", "bin", binaryName);
const binary = process.argv[2] ? path.resolve(process.argv[2]) : defaultBinary;
const token = "packaged-sidecar-smoke-test-token";

if (!existsSync(binary)) {
  console.error(`Packaged sidecar binary not found: ${binary}`);
  process.exit(1);
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "cadencr-sidecar-smoke-"));
const home = path.join(tempRoot, "home");
const dbPath = path.join(tempRoot, "data", "cadencr.db");
const settingsDir = path.join(tempRoot, "settings");
const httpPort = await freePort();
const remotePort = await freePort();
mkdirSync(path.dirname(dbPath), { recursive: true });
mkdirSync(settingsDir, { recursive: true });
mkdirSync(home, { recursive: true });
const child = spawn(binary, [
  "--db-path",
  dbPath,
  "--settings-dir",
  settingsDir,
  "--port",
  String(httpPort),
  "--remote-port",
  String(remotePort),
  "--app-version",
  "smoke-test",
], {
  env: {
    ...process.env,
    HOME: home,
    CADENCR_AUTH_TOKEN: token,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const stdout = [];
const stderr = [];
let exited = false;
let exitCode = null;
let exitSignal = null;
const childExit = new Promise((resolve) => {
  child.once("exit", () => resolve(true));
});

child.stdout.on("data", (chunk) => pushLines(stdout, chunk));
child.stderr.on("data", (chunk) => pushLines(stderr, chunk));
child.on("exit", (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
});

try {
  await waitForHealth(httpPort);
  console.log(`Packaged sidecar smoke test passed on 127.0.0.1:${httpPort}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(describeLogs());
  process.exitCode = 1;
} finally {
  await stopChild();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a local port"));
      });
    });
  });
}

async function waitForHealth(port) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `Packaged sidecar exited before health check passed: code=${exitCode ?? "null"} signal=${exitSignal ?? "null"}`,
      );
    }
    if (await probeHealth(url)) return;
    await sleep(500);
  }
  throw new Error(`Packaged sidecar health check timed out at ${url}`);
}

async function probeHealth(url) {
  try {
    const response = await fetch(url, {
      headers: { "x-cadencr-token": token },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === "cadencr";
  } catch {
    return false;
  }
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(2_000)) return;
  child.kill("SIGKILL");
  await waitForExit(2_000);
}

function waitForExit(timeoutMs) {
  if (exited || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([childExit, sleep(timeoutMs).then(() => false)]);
}

function pushLines(target, chunk) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line.trim()) target.push(line);
  }
  if (target.length > 40) target.splice(0, target.length - 40);
}

function describeLogs() {
  return [
    "Last stdout lines:",
    ...stdout.slice(-20),
    "Last stderr lines:",
    ...stderr.slice(-20),
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
