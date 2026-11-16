#!/usr/bin/env node
// Headless end-to-end launch of an installed/extracted Linux Cadencr build:
// boots it under Xvfb with an empty HOME, drives the renderer over the Chrome
// DevTools Protocol, and checks the things a Linux install gets wrong first —
// the sidecar starts and answers, per-user data lands in the XDG dirs (never
// ~/.cadencr), and the AppImage environment does not leak into the sidecar.
//
//   node e2e-launch.mjs <cadencr-executable> [--appimage | --appimage-fuse]
//
// --appimage runs it with --appimage-extract-and-run (no FUSE needed);
// --appimage-fuse runs it as users do, through a FUSE mount.
//
// Runs inside scripts/linux-container (needs xvfb-run). Exits non-zero on any
// failed check.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [executable, ...flags] = process.argv.slice(2);
if (!executable) {
  console.error("usage: e2e-launch.mjs <cadencr-executable> [--appimage | --appimage-fuse]");
  process.exit(2);
}
const isFuseAppImage = flags.includes("--appimage-fuse");
const isAppImage = isFuseAppImage || flags.includes("--appimage");
const DEVTOOLS_PORT = 9333;
const TIMEOUT_MS = 120_000;

const home = mkdtempSync(path.join(tmpdir(), "cadencr-e2e-home-"));
const env = { ...process.env, HOME: home, ELECTRON_ENABLE_LOGGING: "1" };
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) delete env[key];

const failures = [];
function check(condition, message) {
  console.log(`${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withDeadline(promise, deadline, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(deadline - Date.now(), 0));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// The deadline also bounds each probe: a CDP call to a crashed renderer would
// otherwise keep the check (and the cleanup after it) waiting forever.
async function waitFor(label, probe) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await withDeadline(probe(), deadline, label);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function cdpSession(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  let closed = null;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")), { once: true });
    socket.addEventListener(
      "close",
      () => {
        closed = new Error("CDP socket closed");
        reject(closed);
        for (const waiter of pending.values()) waiter.reject(closed);
        pending.clear();
      },
      { once: true },
    );
  });
  // A close before the first evaluate() must not crash node as an unhandled
  // rejection; evaluate() awaits `opened` again and reports it.
  opened.catch(() => undefined);
  return {
    async evaluate(expression) {
      await opened;
      if (closed) throw closed;
      const id = nextId++;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const { result: value, exceptionDetails } = await result;
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
      return value.value;
    },
    close: () => socket.close(),
  };
}

function sidecarPids() {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("cadencr-service");
      } catch {
        return false; // The process exited between listing and reading.
      }
    });
}

function processEnv(pid) {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
}

const args = ["--no-sandbox", `--remote-debugging-port=${DEVTOOLS_PORT}`];
const command =
  isAppImage && !isFuseAppImage
    ? [executable, "--appimage-extract-and-run", ...args]
    : [executable, ...args];
const app = spawn(
  "xvfb-run",
  ["-a", "-s", "-screen 0 1440x900x24", "dbus-run-session", "--", ...command],
  { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

try {
  const page = await waitFor("the main window", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json();
    return targets.find((target) => target.type === "page" && target.url.includes("/renderer/"));
  });
  check(true, `main window loaded (${page.url})`);
  const session = cdpSession(page.webSocketDebuggerUrl);

  const health = await waitFor("an authenticated /api/health", () =>
    session.evaluate(`(async () => {
      const config = await window.cadencr.runtimeConfig();
      const response = await fetch(config.baseUrl + "/api/health", {
        headers: { "x-cadencr-token": config.authToken },
      });
      return response.ok ? await response.json() : null;
    })()`),
  );
  check(health?.service === "cadencr", "sidecar answers /api/health with the runtime token");

  const rendered = await waitFor("the app shell", () =>
    session.evaluate(`document.getElementById("root")?.childElementCount > 0`),
  );
  check(rendered === true, "React app shell rendered");

  const controls = await session.evaluate(`Boolean(window.cadencr?.usesCustomWindowControls)`);
  check(controls === true, "Linux frameless window uses the app-owned window controls");

  const gpu = await session.evaluate(
    `(async () => Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())))()`,
  );
  console.log(`INFO WebGPU adapter available under Xvfb: ${gpu} (terminal falls back to xterm when false)`);
  session.close();

  const dataDb = path.join(home, ".local/share/cadencr/database/cadencr.db");
  check(existsSync(dataDb), `database created under XDG data (${dataDb})`);
  for (const dir of [path.dirname(path.dirname(dataDb)), path.dirname(dataDb)]) {
    const mode = existsSync(dir) ? (statSync(dir).mode & 0o777).toString(8) : "missing";
    check(mode === "700", `${dir} is private to the user (mode ${mode})`);
  }
  check(existsSync(path.join(home, ".config/cadencr")), "config created under XDG config");
  check(!existsSync(path.join(home, ".cadencr")), "nothing written to the macOS-style ~/.cadencr");

  const pids = sidecarPids();
  check(pids.length > 0, "cadencr-service process is running");
  for (const pid of pids) {
    const sidecarEnv = processEnv(pid);
    const leaked = ["APPDIR", "APPIMAGE", "OWD", "ARGV0", "CHROME_DESKTOP"].filter(
      (key) => key in sidecarEnv,
    );
    check(leaked.length === 0, `sidecar env carries no AppImage/Electron vars (${leaked.join(", ") || "none"})`);
    const mount = isAppImage ? "/tmp/.mount_" : null;
    if (mount) {
      check(
        !(sidecarEnv.PATH ?? "").includes(mount) && !(sidecarEnv.LD_LIBRARY_PATH ?? "").includes(mount),
        "sidecar PATH/LD_LIBRARY_PATH exclude the AppImage mount",
      );
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.log(`FAIL ${failures.at(-1)}`);
  console.log("---- app log (tail) ----");
  console.log(appLog.split("\n").slice(-60).join("\n"));
} finally {
  try {
    process.kill(-app.pid, "SIGTERM");
  } catch (error) {
    console.log(`INFO app already stopped: ${error instanceof Error ? error.message : error}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll end-to-end launch checks passed");
