import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keyDescriptor, pickRendererTarget } from "./isolated-qa/cdp.mjs";
import { down, runWorktrees } from "./isolated-qa/down.mjs";
import { evidenceTemplate, unvalidatedPlatforms } from "./isolated-qa/evidence.mjs";
import { lockPath, withLock } from "./isolated-qa/lock.mjs";
import {
  collectRunProcesses,
  parseProcessTable,
  readProcessTable,
} from "./isolated-qa/processes.mjs";
import {
  DISPOSABLE_KEYS,
  RUN_MARKER,
  STATE_VERSION,
  createRunDir,
  databasePath,
  newRunId,
  qaRoot,
  resolveRunDir,
  runLayout,
  validateState,
  writeState,
} from "./isolated-qa/run.mjs";
import {
  chromeCandidates,
  desktopEnv,
  rendererOnlyConfig,
  serviceArgs,
  waitFor,
} from "./isolated-qa/stack.mjs";
import { allocatePorts } from "./isolated-qa/up.mjs";

const RUN = "/scratch/qa/20261117-101500-a1b2c3";
const START = "Mon Nov 17 10:15:00 2026";

test("runs go under CADENCR_QA_ROOT when set, else under the temp dir", () => {
  assert.equal(qaRoot({ CADENCR_QA_ROOT: "/agent/scratch" }, "/tmp"), "/agent/scratch");
  assert.equal(qaRoot({}, "/var/tmp"), "/var/tmp/cadencr-qa");
  assert.throws(() => qaRoot({ CADENCR_QA_ROOT: "relative" }), /absolute/);
});

test("run ids sort by time and differ within the same second", () => {
  const now = new Date("2026-11-17T10:15:00.123Z");
  assert.equal(newRunId(now, "a1b2c3"), "20261117-101500-a1b2c3");
  assert.notEqual(newRunId(now), newRunId(now));
});

test("every path a run owns sits inside its directory, the database never in the checkout", () => {
  const layout = runLayout(RUN);
  for (const path of Object.values(layout)) assert.ok(path.startsWith(RUN), path);
  for (const key of DISPOSABLE_KEYS) assert.ok(layout[key].startsWith(`${RUN}/`));
  assert.equal(databasePath(layout), `${RUN}/app/db/qa.db`);
  // Settings siblings (plugins, provider installations…) land beside settings, inside app/.
  assert.equal(join(layout.settings, ".."), layout.app);
});

test("a run directory is created fresh and never reused", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-test-"));
  try {
    const layout = createRunDir(root, "run-1");
    // Canonical: macOS's temp dir sits behind the /var -> /private/var symlink.
    assert.equal(layout.runDir, join(realpathSync(root), "run-1"));
    assert.throws(() => createRunDir(root, "run-1"), /EEXIST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run is named by id under the root, or by its directory", () => {
  assert.equal(resolveRunDir("20261117-x", "/root"), "/root/20261117-x");
  assert.equal(resolveRunDir("/other/place/run", "/root"), "/other/place/run");
  assert.throws(() => resolveRunDir(undefined, "/root"), /name the run/);
});

test("down only accepts a state that describes the very directory it was given", () => {
  const state = {
    marker: RUN_MARKER,
    version: STATE_VERSION,
    runId: "20261117-101500-a1b2c3",
    runDir: RUN,
  };
  assert.doesNotThrow(() => validateState(state, RUN));
  assert.throws(() => validateState({ ...state, marker: "other" }, RUN), /not an isolated QA run/);
  assert.throws(() => validateState(state, "/scratch/qa/copied"), /another run/);
  assert.throws(() => validateState({ ...state, version: 99 }, RUN), /version/);
});

test("ps rows keep their start time, single-digit days included", () => {
  const rows = parseProcessTable(
    [
      "  101     1   101 Mon Nov 17 10:15:00 2026     /run/bin/cadencr-service --port 1",
      "  202   101   101 Fri Nov  7 09:01:02 2026     claude --print",
      "garbage line",
    ].join("\n"),
  );
  assert.deepEqual(rows[1], {
    pid: 202,
    ppid: 101,
    pgid: 101,
    startedAt: "Fri Nov 7 09:01:02 2026",
    command: "claude --print",
  });
  assert.equal(rows.length, 2);
});

test("a run owns its recorded roots' descendants and processes of its own binary or profile", () => {
  const layout = runLayout(RUN);
  const table = [
    { pid: 10, ppid: 1, pgid: 10, startedAt: START, command: `${RUN}/bin/cadencr-service` },
    { pid: 11, ppid: 10, pgid: 11, startedAt: START, command: "claude --print" },
    {
      pid: 12,
      ppid: 1,
      pgid: 12,
      startedAt: START,
      command: `${RUN}/bin/cadencr-service mcp-serve`,
    },
    {
      pid: 13,
      ppid: 1,
      pgid: 13,
      startedAt: START,
      command: `chrome --user-data-dir=${layout.profile}`,
    },
    { pid: 14, ppid: 1, pgid: 14, startedAt: START, command: "/other/run/bin/cadencr-service" },
    { pid: 15, ppid: 1, pgid: 15, startedAt: START, command: `tail -f ${RUN}/logs/service.log` },
  ];
  const records = [{ role: "service", pid: 10, pgid: 10, startedAt: START }];
  const { live, owned } = collectRunProcesses(records, layout, table);
  assert.equal(live.length, 1);
  assert.deepEqual(owned.map((row) => row.pid).sort(), [10, 11, 12, 13]);
});

test("a recorded PID now used by another process is left alone", () => {
  const layout = runLayout(RUN);
  const table = [
    { pid: 10, ppid: 1, pgid: 10, startedAt: "Tue Nov 18 08:00:00 2026", command: "vim" },
  ];
  const records = [{ role: "service", pid: 10, pgid: 10, startedAt: START }];
  const { live, owned } = collectRunProcesses(records, layout, table);
  assert.deepEqual(live, []);
  assert.deepEqual(owned, []);
});

test("the CDP target is this run's main window, not the notch, a guest or another run", () => {
  const renderer = "http://127.0.0.1:4100";
  const targets = [
    { type: "page", url: "http://127.0.0.1:4200/" },
    { type: "page", url: `${renderer}/notch.html` },
    { type: "webview", url: `${renderer}/` },
    { type: "page", url: `${renderer}/#/projects/1/features/2` },
  ];
  assert.equal(pickRendererTarget(targets, renderer), targets[3]);
  assert.equal(pickRendererTarget(targets.slice(0, 3), renderer), null);
});

test("the evidence template records commit, surface and the platforms left unvalidated", () => {
  const text = evidenceTemplate({
    runId: "r1",
    runDir: RUN,
    sha: "abc123",
    branch: "feature/x",
    dirty: true,
    surface: "renderer",
    platform: "darwin",
    release: "27.0.0",
    arch: "arm64",
    startedAt: "2026-11-17T10:15:00Z",
  });
  assert.match(text, /`abc123` on `feature\/x` \*\*plus uncommitted changes\*\*/);
  assert.match(text, /Renderer only, in a headless Chrome/);
  assert.match(text, /Desktop-only behaviour .* not exercised/);
  assert.match(text, /Linux: not run \(this run is on macOS\)/);
  assert.deepEqual(unvalidatedPlatforms("linux"), ["macOS: not run (this run is on Linux)"]);
});

test("Chrome is looked up per platform, with an explicit override", () => {
  assert.match(chromeCandidates("darwin", {})[0], /Google Chrome\.app/);
  assert.ok(chromeCandidates("linux", {}).includes("/usr/bin/google-chrome"));
  assert.ok(
    chromeCandidates("linux", {}).every((path) => path.startsWith("/") && !path.includes(".app/")),
  );
  assert.deepEqual(chromeCandidates("linux", { CADENCR_QA_CHROME: "/opt/c" }), ["/opt/c"]);
});

test("the service runs on the run's database, settings, data root, ports and token", () => {
  const layout = runLayout(RUN);
  const args = serviceArgs(layout, { service: 1, frontend: 2, remote: 3 }, "tok");
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--db-path"), `${RUN}/app/db/qa.db`);
  assert.equal(flag("--settings-dir"), `${RUN}/app/settings`);
  assert.equal(flag("--data-dir"), `${RUN}/app/data`);
  assert.equal(flag("--port"), "1");
  assert.equal(flag("--auth-token"), "tok");
  assert.ok(!args.some((arg) => arg.includes("cadencr.local.db")));
});

test("the desktop gets the run's endpoints and a profile inside the run", () => {
  const layout = runLayout(RUN);
  const env = desktopEnv({
    layout,
    ports: { service: 1, frontend: 2, remote: 3 },
    token: "tok",
    runId: "r1",
  });
  assert.equal(env.VITE_API_URL, "http://127.0.0.1:1");
  assert.equal(env.VITE_FRONTEND_PORT, "2");
  assert.equal(env.VITE_API_TOKEN, "tok");
  assert.equal(env.CADENCR_DEV_USER_DATA_DIR, layout.profile);
  assert.equal(env.CADENCR_DB_PATH, `${RUN}/app/db/qa.db`);
});

test("the renderer-only config keeps its dependency cache in the run", () => {
  const config = rendererOnlyConfig("/repo/packages/desktop", `${RUN}/bin/vite-cache`);
  assert.match(
    config,
    /import desktop from "\/repo\/packages\/desktop\/electron\.vite\.config\.ts"/,
  );
  assert.match(config, /\.renderer,/);
  assert.match(config, /cacheDir: ".*\/bin\/vite-cache"/);
});

test("run worktrees are the app's checkouts under the data root", () => {
  const runDir = mkdtempSync(join(tmpdir(), "qa-run-"));
  try {
    const layout = runLayout(runDir);
    const worktree = join(layout.data, "worktrees", "qa-project", "feature-a");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(layout.data, "worktrees", "qa-project", "not-a-checkout"));
    writeFileSync(join(worktree, ".git"), "gitdir: /somewhere/.git/worktrees/feature-a\n");
    assert.deepEqual(runWorktrees(layout), [worktree]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** A stopped run on disk, as `qa:up` leaves it, with no live process. */
function fakeRun(status, starter) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-root-")));
  const layout = createRunDir(root, "20261117-101500-a1b2c3");
  mkdirSync(layout.project);
  writeFileSync(layout.evidence, "# evidence\n");
  writeFileSync(join(layout.screenshots, "shot.png"), "png");
  writeState(layout, {
    marker: RUN_MARKER,
    version: STATE_VERSION,
    runId: "20261117-101500-a1b2c3",
    runDir: layout.runDir,
    status,
    starter,
    ports: {},
    processes: [{ role: "service", pid: 999_999, pgid: 999_999, startedAt: START }],
  });
  return { root, layout };
}

test("down removes the disposable parts and keeps the report", async () => {
  const { root, layout } = fakeRun("ready");
  try {
    await down({ target: layout.runDir, purge: false });
    for (const key of DISPOSABLE_KEYS) assert.equal(existsSync(layout[key]), false, key);
    assert.ok(existsSync(join(layout.screenshots, "shot.png")));
    assert.equal(JSON.parse(readFileSync(layout.state, "utf8")).status, "down");
    await down({ target: layout.runDir, purge: true });
    assert.equal(existsSync(layout.runDir), false);
    assert.ok(existsSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("down refuses a run whose qa:up is still starting it", async () => {
  const self = readProcessTable().find((row) => row.pid === process.pid);
  const { root, layout } = fakeRun("starting", { pid: process.pid, startedAt: self.startedAt });
  try {
    await assert.rejects(down({ target: layout.runDir, purge: false }), /still starting/);
    assert.ok(existsSync(layout.app));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("down also waits for a qa:up still cleaning up its failed start", async () => {
  const self = readProcessTable().find((row) => row.pid === process.pid);
  const { root, layout } = fakeRun("failed", { pid: process.pid, startedAt: self.startedAt });
  try {
    await assert.rejects(down({ target: layout.runDir, purge: true }), /still starting/);
    assert.ok(existsSync(layout.state));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waitFor fails as soon as a watched process is gone", async () => {
  const gone = { role: "service", pid: 999_999, startedAt: START, log: "/x/service.log" };
  await assert.rejects(
    waitFor("health", async () => false, { timeoutMs: 60_000, watch: [gone] }),
    /service exited while waiting for health; see \/x\/service\.log/,
  );
});

test("the start lock serializes holders and reclaims a dead owner's lock", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qa-lock-"));
  try {
    const lock = lockPath("/repo", "electron-start", tmp);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999, startedAt: START }));
    const order = [];
    await Promise.all(
      ["a", "b"].map((name) =>
        withLock(lock, name, async () => {
          order.push(`${name}:in`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push(`${name}:out`);
        }),
      ),
    );
    assert.deepEqual(
      order.map((step) => step.split(":")[1]),
      ["in", "out", "in", "out"],
    );
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CDP keys carry the codes that trigger their default actions", () => {
  assert.deepEqual(keyDescriptor("Tab"), { code: "Tab", keyCode: 9 });
  assert.deepEqual(keyDescriptor("1"), { code: "Digit1", keyCode: 49 });
  assert.deepEqual(keyDescriptor("k"), { code: "KeyK", keyCode: 75 });
});

test("allocated ports are distinct", async () => {
  const ports = await allocatePorts(["service", "frontend", "remote", "cdp"]);
  assert.equal(new Set(Object.values(ports)).size, 4);
});
