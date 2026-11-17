// `pnpm qa:up`: start one run on fresh, run-owned state (database, settings,
// data root, ports, browser profile) and verify it before reporting it ready.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { generateToken } from "../dev-env.mjs";
import { build, copyServiceBinary, preflight, serviceBinary } from "./build.mjs";
import { evidenceTemplate } from "./evidence.mjs";
import { lockPath, withLock } from "./lock.mjs";
import { readProcessTable, stopRunProcesses } from "./processes.mjs";
import {
  DISPOSABLE_KEYS,
  RUN_MARKER,
  STATE_VERSION,
  createRunDir,
  newRunId,
  qaRoot,
  writeState,
} from "./run.mjs";
import {
  seedWorkspace,
  spawnService,
  startChrome,
  startDesktop,
  verifyService,
  waitForApp,
  waitForRenderer,
} from "./stack.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Ports the OS hands out as free, distinct from each other. */
export async function allocatePorts(names) {
  const ports = {};
  const taken = new Set();
  for (const name of names) {
    let port = await freePort();
    while (taken.has(port)) port = await freePort();
    taken.add(port);
    ports[name] = port;
  }
  return ports;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The commit under test: the evidence must never name an empty or guessed SHA. */
export function gitFacts(repoRoot) {
  return {
    sha: git(repoRoot, ["rev-parse", "HEAD"]),
    branch: git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]) !== "",
  };
}

/**
 * A throwaway Git project for agent turns: its worktrees land in the run's data
 * dir. The user's signing and hook settings must not block or touch its commit.
 */
function createScratchProject(path) {
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "README.md"), "# QA scratch project\n");
  const config = [
    ...["-c", "user.name=cadencr-qa", "-c", "user.email=qa@localhost"],
    ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"],
  ];
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["add", "README.md"]);
  git(path, [...config, "commit", "-q", "-m", "init"]);
}

function initialState({ repoRoot, layout, runId, options, ports, commit }) {
  const ui = options.surface !== "service";
  const self = readProcessTable().find((row) => row.pid === process.pid);
  if (!self) throw new Error(`ps does not list this process (pid ${process.pid})`);
  return {
    marker: RUN_MARKER,
    version: STATE_VERSION,
    runId,
    runDir: layout.runDir,
    repoRoot,
    surface: options.surface,
    marketplace: options.marketplace,
    status: "starting",
    // `qa:down` refuses to tear a run down while this process is still starting it.
    starter: { role: "qa:up", pid: process.pid, startedAt: self.startedAt },
    createdAt: new Date().toISOString(),
    platform: { os: process.platform, release: os.release(), arch: process.arch },
    home: os.homedir(),
    git: commit,
    ports,
    urls: {
      service: `http://127.0.0.1:${ports.service}`,
      renderer: ui ? `http://127.0.0.1:${ports.frontend}` : null,
      cdp: ui ? `http://127.0.0.1:${ports.cdp}` : null,
    },
    token: generateToken(),
    paths: layout,
    processes: [],
  };
}

async function startUi({ repoRoot, layout, state, options, record }) {
  const { ports, token, runId, surface, urls } = state;
  const timeoutMs = options.startTimeoutSec * 1000;
  const logs = [join(layout.logs, "desktop.log")];
  const rendererUrl = urls.renderer;
  if (surface === "electron") {
    // Electron runs of one checkout share `packages/desktop/out` (identical
    // builds): serialize their starts so one build never empties the directory
    // while another Electron loads from it.
    const lock = lockPath(repoRoot, "electron-start");
    await withLock(lock, `run ${runId} to finish starting Electron`, async () => {
      const electron = record(startDesktop({ repoRoot, layout, ports, token, runId, surface }));
      await waitForApp({ ports, rendererUrl, owner: electron, watch: [electron], timeoutMs, logs });
    });
    return;
  }
  const renderer = record(startDesktop({ repoRoot, layout, ports, token, runId, surface }));
  await waitForRenderer({ rendererUrl, watch: [renderer], timeoutMs, logs });
  const chrome = record(startChrome({ layout, ports, rendererUrl, headed: options.headed }));
  logs.push(chrome.log);
  await waitForApp({
    ports,
    rendererUrl,
    owner: chrome,
    watch: [renderer, chrome],
    timeoutMs,
    logs,
  });
}

async function start({ repoRoot, layout, state, options }) {
  const record = (entry) => {
    state.processes.push(entry);
    writeState(layout, state);
    return entry;
  };
  const binary = serviceBinary(repoRoot, { marketplace: options.marketplace });
  if (!existsSync(binary)) {
    const flag = options.marketplace ? " --marketplace" : "";
    throw new Error(`${binary} is missing: run \`pnpm qa:build${flag}\``);
  }
  copyServiceBinary(binary, join(layout.bin, "cadencr-service"));
  createScratchProject(layout.project);
  const { ports, token, urls } = state;
  const service = record(spawnService({ layout, ports, token }));
  const timeoutMs = options.startTimeoutSec * 1000;
  await verifyService({ record: service, ports, token, serviceUrl: urls.service, timeoutMs });
  if (options.seed) {
    const projectPath = layout.project;
    state.project = await seedWorkspace({ serviceUrl: urls.service, token, projectPath });
  }
  if (state.surface !== "service") await startUi({ repoRoot, layout, state, options, record });
}

/**
 * Stop what a failed start launched and drop its heavy parts (binary, database,
 * profile): only the logs, state and evidence are needed to inspect it.
 */
async function abandon(layout, state, error) {
  state.status = "failed";
  state.error = error instanceof Error ? error.message : String(error);
  writeState(layout, state);
  let detail = `Run kept for inspection: ${layout.runDir} (logs in logs/)`;
  try {
    const { remaining } = await stopRunProcesses(state.processes, layout);
    if (remaining.length > 0) {
      detail += `\nStill running after SIGKILL: ${remaining.map((row) => row.pid).join(", ")}`;
    } else {
      for (const key of DISPOSABLE_KEYS) rmSync(layout[key], { recursive: true, force: true });
      state.processes = [];
      writeState(layout, state);
    }
  } catch (cleanup) {
    detail += `\nCleanup failed too: ${cleanup instanceof Error ? cleanup.message : cleanup}`;
  }
  return new Error(`${state.error}\n${detail}`);
}

/** Create, start and verify one run; on failure stop what it started and keep its logs. */
export async function up({ repoRoot, options }) {
  if (options.skipBuild) preflight({ repoRoot, surface: options.surface });
  else build({ repoRoot, surface: options.surface, marketplace: options.marketplace });
  // Everything that can fail before the run has a state file happens first.
  const commit = gitFacts(repoRoot);
  const ports = await allocatePorts(["service", "frontend", "remote", "cdp"]);
  const runId = newRunId();
  const layout = createRunDir(qaRoot(), runId);
  const state = initialState({ repoRoot, layout, runId, options, ports, commit });
  writeState(layout, state);
  const { os: platform, release, arch } = state.platform;
  const { createdAt: startedAt, surface } = state;
  const evidence = { runId, runDir: layout.runDir, surface, startedAt, ...commit };
  writeFileSync(layout.evidence, evidenceTemplate({ ...evidence, platform, release, arch }), {
    mode: 0o600,
  });
  try {
    await start({ repoRoot, layout, state, options });
  } catch (error) {
    throw await abandon(layout, state, error);
  }
  state.status = "ready";
  state.readyAt = new Date().toISOString();
  writeState(layout, state);
  return state;
}
