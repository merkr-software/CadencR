// Starting the processes of one QA run. Nothing here compiles Rust: `qa:up`
// runs the build phase first, so these waits only cover start-up and the
// renderer's first load, and they give up early when a process dies.
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  APP_MOUNTED_EXPRESSION,
  evaluate,
  listTargets,
  openSession,
  pickRendererTarget,
} from "./cdp.mjs";
import { isAlive, portOwnedBy, spawnDetached } from "./processes.mjs";
import { databasePath } from "./run.mjs";

/** Poll `probe` until it returns a truthy value; fail as soon as a watched process exits. */
export async function waitFor(what, probe, { timeoutMs, watch = [], logs = [] }) {
  const deadline = Date.now() + timeoutMs;
  let lastProblem = "no answer yet";
  while (Date.now() < deadline) {
    const dead = watch.find((record) => !isAlive(record));
    if (dead) throw new Error(`${dead.role} exited while waiting for ${what}; see ${dead.log}`);
    try {
      const value = await Promise.race([
        probe(),
        // Unref'd: a probe that wins must not keep the CLI alive for 10 s.
        delay(10_000, undefined, { ref: false }).then(() => {
          throw new Error("probe got no answer within 10s");
        }),
      ]);
      if (value) return value;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(
    `timed out after ${timeoutMs / 1000}s waiting for ${what} (${lastProblem}); see ${logs.join(", ")}`,
  );
}

export function serviceArgs(layout, ports, token) {
  return [
    "--db-path",
    databasePath(layout),
    "--settings-dir",
    layout.settings,
    "--data-dir",
    layout.data,
    "--port",
    String(ports.service),
    "--frontend-port",
    String(ports.frontend),
    "--remote-port",
    String(ports.remote),
    "--auth-token",
    token,
  ];
}

async function healthStatus(serviceUrl, token) {
  const headers = token ? { "X-Cadencr-Token": token } : {};
  const response = await fetch(`${serviceUrl}/api/health`, {
    headers,
    signal: AbortSignal.timeout(2_000),
  });
  return response.status;
}

/** Start the service from the run's own copy of the debug binary. */
export function spawnService({ layout, ports, token }) {
  return spawnDetached({
    role: "service",
    command: join(layout.bin, "cadencr-service"),
    args: serviceArgs(layout, ports, token),
    // The debug binary loads packages/service/.env by its compile-time path;
    // every value that matters is overridden by the flags above.
    cwd: layout.app,
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
    logFile: join(layout.logs, "service.log"),
  });
}

/**
 * Prove three things before anything talks to the service: it answers with our
 * token, refuses a request without one, and the port's listener is this process.
 */
export async function verifyService({ record, ports, token, serviceUrl, timeoutMs }) {
  await waitFor(
    "the service health check",
    async () => (await healthStatus(serviceUrl, token)) === 200,
    {
      timeoutMs,
      watch: [record],
      logs: [record.log],
    },
  );
  const anonymous = await healthStatus(serviceUrl, null);
  if (anonymous !== 401)
    throw new Error(`service answered ${anonymous} without a token, expected 401`);
  if (!portOwnedBy(ports.service, record)) {
    throw new Error(`port ${ports.service} is not served by the QA service (pid ${record.pid})`);
  }
}

/**
 * A fresh database opens on onboarding and the telemetry decision: QA starts
 * past both (telemetry off, a QA run reports nothing) with one scratch project.
 */
export async function seedWorkspace({ serviceUrl, token, projectPath }) {
  const headers = { "X-Cadencr-Token": token, "Content-Type": "application/json" };
  const request = async (method, path, body) => {
    const response = await fetch(`${serviceUrl}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };
  await request("PUT", "/api/workspace/settings/onboarding_step", { value: "completed" });
  await request("PUT", "/api/telemetry", {
    diagnostics_enabled: false,
    usage_enabled: false,
    audience_enabled: false,
  });
  return request("POST", "/api/projects", { name: "qa-project", path: projectPath });
}

export function desktopEnv({ layout, ports, token, runId }) {
  return {
    ...process.env,
    VITE_FRONTEND_PORT: String(ports.frontend),
    VITE_API_URL: `http://127.0.0.1:${ports.service}`,
    VITE_API_TOKEN: token,
    CADENCR_REMOTE_PORT: String(ports.remote),
    CADENCR_DB_PATH: databasePath(layout),
    CADENCR_DEV_USER_DATA_DIR: layout.profile,
    CADENCR_DEV_USER_DATA_SUFFIX: `qa-${runId}`,
  };
}

/**
 * A Vite config, written into the run, that serves only the renderer half of
 * the desktop config. `electron-vite dev --rendererOnly` still launches
 * Electron, which a Chrome-only run must not do. Its dependency cache stays in
 * the run: this config differs from the desktop one, so sharing
 * `node_modules/.vite` would re-optimize it under every other dev server.
 */
export function rendererOnlyConfig(desktopDir, cacheDir) {
  const source = JSON.stringify(join(desktopDir, "electron.vite.config.ts"));
  return [
    `import desktop from ${source};`,
    "export default (env) => ({",
    '  ...(typeof desktop === "function" ? desktop(env) : desktop).renderer,',
    `  cacheDir: ${JSON.stringify(cacheDir)},`,
    "});",
    "",
  ].join("\n");
}

function viteBin(desktopDir) {
  const require = createRequire(join(desktopDir, "package.json"));
  return join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
}

export function startDesktop({ repoRoot, layout, ports, token, runId, surface }) {
  const desktopDir = join(repoRoot, "packages", "desktop");
  const env = desktopEnv({ layout, ports, token, runId });
  const logFile = join(layout.logs, "desktop.log");
  if (surface === "electron") {
    return spawnDetached({
      role: "electron",
      command: process.execPath,
      args: [
        join(desktopDir, "scripts", "electron-vite.mjs"),
        "dev",
        "--remoteDebuggingPort",
        String(ports.cdp),
      ],
      cwd: desktopDir,
      env,
      logFile,
    });
  }
  const config = join(layout.bin, "vite.renderer.config.mjs");
  writeFileSync(config, rendererOnlyConfig(desktopDir, join(layout.bin, "vite-cache")), {
    mode: 0o600,
  });
  return spawnDetached({
    role: "renderer",
    command: process.execPath,
    args: [viteBin(desktopDir), "--config", config],
    cwd: desktopDir,
    env,
    logFile,
  });
}

/** Chrome candidates per platform; `CADENCR_QA_CHROME` wins. */
export function chromeCandidates(platform, env = process.env) {
  if (env.CADENCR_QA_CHROME) return [env.CADENCR_QA_CHROME];
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export function startChrome({ layout, ports, rendererUrl, headed }) {
  const command = chromeCandidates(process.platform).find((path) => existsSync(path));
  if (!command) throw new Error("no Chrome found; set CADENCR_QA_CHROME to its executable");
  return spawnDetached({
    role: "chrome",
    command,
    args: [
      `--remote-debugging-port=${ports.cdp}`,
      `--user-data-dir=${layout.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      ...(headed ? [] : ["--headless=new"]),
      rendererUrl,
    ],
    cwd: layout.runDir,
    env: process.env,
    logFile: join(layout.logs, "chrome.log"),
  });
}

/** The renderer page is up on CDP, served by this run, and the app has mounted. */
export async function waitForApp({ ports, rendererUrl, owner, watch, timeoutMs, logs }) {
  await waitFor(
    "the renderer page on CDP",
    async () => pickRendererTarget(await listTargets(ports.cdp), rendererUrl),
    { timeoutMs, watch, logs },
  );
  if (!portOwnedBy(ports.cdp, owner)) {
    throw new Error(`CDP port ${ports.cdp} is not served by this run's ${owner.role}`);
  }
  await waitFor(
    "the app to mount",
    async () => {
      const session = await openSession(ports.cdp, rendererUrl);
      try {
        return await evaluate(session, APP_MOUNTED_EXPRESSION);
      } finally {
        session.close();
      }
    },
    { timeoutMs, watch, logs },
  );
}

export async function waitForRenderer({ rendererUrl, watch, timeoutMs, logs }) {
  await waitFor(
    "the renderer dev server",
    async () => (await fetch(rendererUrl, { signal: AbortSignal.timeout(2_000) })).ok,
    { timeoutMs, watch, logs },
  );
}
