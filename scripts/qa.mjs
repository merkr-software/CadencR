// Isolated, reproducible QA runs of the Cadencr app. See .agents/skills/qa/SKILL.md.
//
//   pnpm qa:build                       toolchain checks + Rust build (no time limit)
//   pnpm qa:up [--surface electron|renderer|service] [--skip-build] [--headed] [--marketplace]
//   pnpm qa:down <run> [--purge]        stop and remove exactly that run
//   pnpm qa -- status <run> | list | env <run>
//   pnpm qa -- cdp <run> eval <js> | click <selector|text=…> | type <text> | key <key>
//                         | screenshot [name] | targets
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as cdp from "./isolated-qa/cdp.mjs";
import { findInstalledNode, nodeRequirement, satisfiesRange } from "./node-requirement.mjs";
import { down } from "./isolated-qa/down.mjs";
import { SURFACES } from "./isolated-qa/evidence.mjs";
import { isAlive } from "./isolated-qa/processes.mjs";
import {
  STATE_FILE,
  readState,
  resolveRunDir,
  runLayout,
  runsRoot,
  shellQuote,
} from "./isolated-qa/run.mjs";
import { build } from "./isolated-qa/build.mjs";
import { up } from "./isolated-qa/up.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const SURFACE_NAMES = Object.keys(SURFACES);

export function parseUpOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      surface: { type: "string", default: "electron" },
      "skip-build": { type: "boolean", default: false },
      marketplace: { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      "no-seed": { type: "boolean", default: false },
      "start-timeout": { type: "string", default: "300" },
    },
  });
  if (!SURFACE_NAMES.includes(values.surface)) {
    throw new Error(`--surface must be one of ${SURFACE_NAMES.join(", ")}`);
  }
  const startTimeoutSec = Number(values["start-timeout"]);
  if (!Number.isFinite(startTimeoutSec) || startTimeoutSec <= 0) {
    throw new Error("--start-timeout takes a number of seconds");
  }
  return {
    surface: values.surface,
    skipBuild: values["skip-build"],
    marketplace: values.marketplace,
    headed: values.headed,
    seed: !values["no-seed"],
    startTimeoutSec,
  };
}

/** Shell lines an agent can `eval` to address this run. */
export function envLines(state) {
  const values = {
    QA_RUN_ID: state.runId,
    QA_RUN_DIR: state.runDir,
    QA_SERVICE_URL: state.urls.service,
    QA_TOKEN: state.token,
    QA_RENDERER_URL: state.urls.renderer ?? "",
    QA_CDP_PORT: state.surface === "service" ? "" : String(state.ports.cdp),
    QA_PROJECT_ID: state.project?.id === undefined ? "" : String(state.project.id),
    QA_EVIDENCE: state.paths.evidence,
  };
  return Object.entries(values).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
}

function printReady(state) {
  console.log(`\nQA run ${state.runId} is ready (${state.surface}).`);
  console.log(`  run dir:   ${state.runDir}`);
  console.log(`  state:     ${state.paths.state}`);
  console.log(`  evidence:  ${state.paths.evidence}`);
  console.log(`  service:   ${state.urls.service}  (header X-Cadencr-Token from state.json)`);
  if (state.urls.renderer) console.log(`  renderer:  ${state.urls.renderer}`);
  if (state.urls.cdp) console.log(`  cdp:       ${state.urls.cdp}`);
  if (state.project) console.log(`  project:   #${state.project.id} ${state.paths.project}`);
  console.log(`  tested:    ${state.git.sha}${state.git.dirty ? " + uncommitted changes" : ""}`);
  // The absolute path works from any shell, whatever its CADENCR_QA_ROOT.
  console.log(`\nStop it with: pnpm qa:down ${shellQuote(state.runDir)}`);
}

function status(state) {
  console.log(`${state.runId}  ${state.status}  ${state.surface}  ${state.git.sha.slice(0, 12)}`);
  for (const record of state.processes) {
    console.log(
      `  ${record.role.padEnd(8)} pid ${record.pid}  ${isAlive(record) ? "alive" : "gone"}`,
    );
  }
}

function list() {
  const root = runsRoot();
  if (!existsSync(root)) return console.log(`No runs under ${root}`);
  for (const name of readdirSync(root).sort()) {
    if (!existsSync(join(root, name, STATE_FILE))) continue;
    try {
      status(readState(join(root, name)));
    } catch (error) {
      console.log(`${name}  unreadable: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function cdpCommand(state, [action, ...rest]) {
  if (action === "targets")
    return console.log(JSON.stringify(await cdp.listTargets(state.ports.cdp), null, 2));
  const session = await cdp.openSession(state.ports.cdp, state.urls.renderer);
  try {
    if (action === "eval")
      return console.log(JSON.stringify(await cdp.evaluate(session, rest.join(" ")), null, 2));
    if (action === "click")
      return console.log(JSON.stringify(await cdp.click(session, rest.join(" "))));
    if (action === "type") return await cdp.typeText(session, rest.join(" "));
    if (action === "key") return await cdp.pressKey(session, rest[0]);
    if (action === "screenshot") {
      const file = cdp.defaultScreenshotPath(runLayout(state.runDir), rest[0]);
      return console.log(await cdp.screenshot(session, file));
    }
    throw new Error(`unknown cdp action: ${action}`);
  } finally {
    session.close();
  }
}

const runState = (target) => readState(resolveRunDir(target, runsRoot()));

async function main([command, ...args]) {
  if (command === "build") return build({ repoRoot, ...parseUpOptions(args) });
  if (command === "up") return printReady(await up({ repoRoot, options: parseUpOptions(args) }));
  if (command === "down") {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { purge: { type: "boolean", default: false } },
    });
    return down({ target: positionals[0], purge: values.purge });
  }
  if (command === "status") return status(runState(args[0]));
  if (command === "list") return list();
  if (command === "env") return console.log(envLines(runState(args[0])).join("\n"));
  if (command === "cdp") {
    const state = runState(args[0]);
    if (state.surface === "service") throw new Error("a service-only run has no CDP target");
    return cdpCommand(state, args.slice(1));
  }
  throw new Error(
    "usage: qa.mjs build|up|down|status|list|env|cdp (see the header of scripts/qa.mjs)",
  );
}

/**
 * The Node a run's children need (`engines.node`): the running one when it
 * qualifies, else the installed .nvmrc version, as the pre-commit hook picks it
 * (scripts/node-requirement.mjs). Electron and Vite start from
 * `process.execPath`, so qa.mjs reruns itself on that Node rather than failing.
 */
export function nodeForRuns(requirement, current, findInstalled = findInstalledNode) {
  if (satisfiesRange(current, requirement.range)) return null;
  const installed = findInstalled(requirement);
  if (installed) return { node: join(installed.binDir, "node"), version: installed.version };
  throw new Error(
    `node ${current} is outside ${requirement.range} (package.json engines) and no compatible ` +
      `install was found. Fix: \`fnm install ${requirement.nvmrc}\` or \`nvm install ${requirement.nvmrc}\`.`,
  );
}

function runOnQualifyingNode(args) {
  const other = nodeForRuns(nodeRequirement(repoRoot), process.versions.node);
  if (!other) return false;
  console.error(
    `qa: running on node ${other.version} (${process.versions.node} is outside engines.node)`,
  );
  const result = spawnSync(other.node, [scriptPath, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  try {
    if (!runOnQualifyingNode(args)) {
      main(args).catch((error) => {
        console.error(`qa: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      });
    }
  } catch (error) {
    console.error(`qa: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
