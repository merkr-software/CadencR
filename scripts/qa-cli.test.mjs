import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireServiceBinary } from "./isolated-qa/build.mjs";
import { down } from "./isolated-qa/down.mjs";
import {
  RUN_MARKER,
  STATE_VERSION,
  createRunDir,
  readState,
  resolveRunDir,
  runsRoot,
  shellQuote,
  writeState,
} from "./isolated-qa/run.mjs";
import { announcesNodeSwitch, envLines, nodeForRuns, parseUpOptions } from "./qa.mjs";

// The `pnpm qa` command line: options, shell output, Node choice, run lookup.
const RUN = "/scratch/qa/20261117-101500-a1b2c3";

test("qa:up options default to the real Electron app and validate the surface", () => {
  assert.deepEqual(parseUpOptions([]), {
    surface: "electron",
    skipBuild: false,
    marketplace: false,
    headed: false,
    seed: true,
    startTimeoutSec: 300,
  });
  assert.equal(parseUpOptions(["--surface", "renderer", "--marketplace"]).marketplace, true);
  assert.throws(() => parseUpOptions(["--surface", "html"]), /--surface/);
  assert.throws(() => parseUpOptions(["--start-timeout", "soon"]), /seconds/);
});

const state = () => ({
  runId: "r1",
  runDir: RUN,
  surface: "electron",
  urls: { service: "http://127.0.0.1:1", renderer: "http://127.0.0.1:2" },
  ports: { cdp: 4 },
  token: "tok",
  project: { id: 1 },
  paths: { evidence: `${RUN}/evidence.md` },
});

test("env lines address one run, quoted for the shell", () => {
  const lines = envLines(state());
  assert.ok(lines.includes("export QA_CDP_PORT=4"));
  assert.ok(lines.includes("export QA_TOKEN=tok"));
  assert.ok(lines.includes(`export QA_RUN_DIR=${RUN}`));
  const quoted = envLines({ ...state(), runDir: "/tmp/it's" }).find((line) =>
    line.includes("QA_RUN_DIR"),
  );
  assert.equal(quoted, "export QA_RUN_DIR='/tmp/it'\\''s'");
});

test("qa runs on the engines Node, rerunning itself on an installed one when needed", () => {
  const requirement = { range: ">=22.19.0 <23.0.0", nvmrc: "22.19.0" };
  const installed = () => ({ binDir: "/fnm/v22.19.0/installation/bin", version: "22.19.0" });
  assert.equal(nodeForRuns(requirement, "22.19.0", installed), null);
  assert.deepEqual(nodeForRuns(requirement, "22.18.0", installed), {
    node: "/fnm/v22.19.0/installation/bin/node",
    version: "22.19.0",
  });
  assert.throws(() => nodeForRuns(requirement, "26.0.0", () => null), /fnm install 22\.19\.0/);
});

test("only the commands that start a run say qa switched Node", () => {
  assert.ok(announcesNodeSwitch("up"));
  assert.ok(announcesNodeSwitch("build"));
  for (const command of ["env", "status", "list", "cdp", "down", undefined]) {
    assert.equal(announcesNodeSwitch(command), false, String(command));
  }
});

test("every command finds runs under a root reached through a symlink", async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "qa-real-root-")));
  const link = join(realpathSync(tmpdir()), `qa-linked-root-${process.pid}`);
  symlinkSync(real, link);
  const previous = process.env.CADENCR_QA_ROOT;
  process.env.CADENCR_QA_ROOT = link;
  try {
    assert.equal(runsRoot(), real);
    const layout = createRunDir(runsRoot(), "20261117-101500-a1b2c3");
    writeState(layout, {
      marker: RUN_MARKER,
      version: STATE_VERSION,
      runId: "20261117-101500-a1b2c3",
      runDir: layout.runDir,
      status: "ready",
      ports: {},
      processes: [],
    });
    // What `list`, `status`, `env` and `cdp` read, by id and through the link:
    assert.equal(readState(resolveRunDir("20261117-101500-a1b2c3")).runDir, layout.runDir);
    assert.equal(
      readState(join(runsRoot(), "20261117-101500-a1b2c3")).runId,
      layout.runDir.split("/").at(-1),
    );
    assert.equal(readState(resolveRunDir(join(link, "20261117-101500-a1b2c3"))).status, "ready");
    // ...and `down` by id.
    await down({ target: "20261117-101500-a1b2c3", purge: true });
    assert.equal(existsSync(layout.runDir), false);
  } finally {
    if (previous === undefined) delete process.env.CADENCR_QA_ROOT;
    else process.env.CADENCR_QA_ROOT = previous;
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("printed commands and env lines survive spaces and quotes in paths", () => {
  assert.equal(shellQuote("/private/tmp/qa/run-1"), "/private/tmp/qa/run-1");
  assert.equal(shellQuote("/tmp/cadencr independent qa/run"), "'/tmp/cadencr independent qa/run'");
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
});

test("qa:up without a built service names the build to run", () => {
  const missing = () => false;
  assert.throws(
    () => requireServiceBinary("/repo", {}, missing),
    /no service binary at \/repo\/target\/debug\/cadencr-service: run `pnpm qa:build` first/,
  );
  assert.throws(
    () => requireServiceBinary("/repo", { marketplace: true }, missing),
    /target\/qa-marketplace\/debug\/cadencr-service: run `pnpm qa:build --marketplace` first/,
  );
  assert.equal(
    requireServiceBinary("/repo", {}, () => true),
    "/repo/target/debug/cadencr-service",
  );
});
