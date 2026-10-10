import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { RUN_ARGS } from "./service-dev-watch.mjs";

const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEV_COMMAND_PATTERNS = [
  /node_modules\/\.bin\/turbo run dev/,
  /@turbo\/[^/]+\/bin\/turbo run dev/,
  /node .*electron-vite\.mjs dev/,
  /Electron\.app\/Contents\/MacOS\/Electron \./,
  /cargo-watch watch .*cadencr-service/,
  // scripts/service-dev-watch.mjs and the watchexec it prefers over cargo-watch.
  /node .*scripts\/service-dev-watch\.mjs/,
  new RegExp(`watchexec .*-- cargo ${escapeRegExp(RUN_ARGS.join(" "))}`),
  /target\/debug\/cadencr-service/,
  /node .*astro dev/,
];

export function collectDevProcessGroups(rows, repoRoot, currentPid = process.pid, rootPid) {
  const groups = new Set();
  const descendantPids = rootPid === undefined ? null : collectDescendantPids(rows, rootPid);
  const requireRepoRoot = descendantPids === null;
  for (const row of rows) {
    if (row.pid === currentPid) continue;
    if (row.pgid <= 1) continue;
    if (descendantPids !== null && !descendantPids.has(row.pid)) continue;
    if (requireRepoRoot && !row.command.includes(repoRoot)) continue;
    if (!matchesDevCommand(row.command)) continue;
    groups.add(row.pgid);
  }
  return [...groups].sort((a, b) => a - b);
}

export function collectDescendantPids(rows, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.pid) || !descendants.has(row.ppid)) continue;
      descendants.add(row.pid);
      changed = true;
    }
  }
  return descendants;
}

export function parsePsRows(output) {
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }));
}

export function readProcessRows() {
  const result = spawnSync("ps", ["-Ao", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
  });
  if (result.error) throw result.error;
  return parsePsRows(result.stdout);
}

export function remainingDevProcessGroups(rows, groups) {
  const observedGroups = new Set(groups);
  const remainingGroups = new Set();
  for (const row of rows) {
    if (!observedGroups.has(row.pgid)) continue;
    if (!matchesDevCommand(row.command)) continue;
    remainingGroups.add(row.pgid);
  }
  return [...remainingGroups].sort((a, b) => a - b);
}

export async function stopDevProcessGroups(groups, waitMs = 800) {
  if (groups.length === 0) return { terminated: [], killed: [] };
  signalGroups(groups, "SIGTERM");
  await delay(waitMs);

  const remaining = remainingDevProcessGroups(readProcessRows(), groups);
  signalGroups(remaining, "SIGKILL");
  return { terminated: groups, killed: remaining };
}

export function signalGroups(groups, signal) {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

function matchesDevCommand(command) {
  return DEV_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
