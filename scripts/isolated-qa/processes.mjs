// Processes of an isolated QA run: started detached in their own process group,
// recorded with their start time, and stopped only after that identity is
// re-checked, so a recycled PID never gets a signal meant for the run.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectDescendantPids, signalGroups } from "../dev-cleanup.mjs";

const PS_MAX_BUFFER = 16 * 1024 * 1024;
// `lstart` is "Mon Nov 17 10:15:00 2026" (macOS and procps alike under LC_ALL=C).
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

const normalizeStart = (value) => value.trim().replace(/\s+/g, " ");

export function parseProcessTable(output) {
  return output
    .split("\n")
    .map((line) => line.match(PS_ROW))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: normalizeStart(match[4]),
      command: match[5],
    }));
}

export function readProcessTable() {
  const result = spawnSync("ps", ["-Ao", "pid=,ppid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: PS_MAX_BUFFER,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`);
  return parseProcessTable(result.stdout);
}

/** Start a command in a new process group, appending its output to `logFile`. */
export function spawnDetached({ role, command, args, cwd, env, logFile }) {
  const fd = openSync(logFile, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (child.pid === undefined) throw new Error(`could not start ${role}: ${command}`);
  child.on("error", (error) => {
    console.error(`${role} failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.unref();
  const row = readProcessTable().find((entry) => entry.pid === child.pid);
  if (!row) throw new Error(`${role} exited immediately; see ${logFile}`);
  return { role, pid: child.pid, pgid: row.pgid, startedAt: row.startedAt, command, log: logFile };
}

export function isSameProcess(record, table) {
  return table.some((row) => row.pid === record.pid && row.startedAt === record.startedAt);
}

export function isAlive(record) {
  return isSameProcess(record, readProcessTable());
}

/** The process itself and every ancestor: never signalled, even when they mention the run. */
export function ancestorPids(table, pid = process.pid) {
  const ancestors = new Set();
  let current = pid;
  while (current > 1 && !ancestors.has(current)) {
    ancestors.add(current);
    current = table.find((row) => row.pid === current)?.ppid ?? 0;
  }
  return ancestors;
}

/**
 * Every live process the run owns: the recorded roots that still match their
 * start time, their descendants (agent CLIs may leave the group), and processes
 * started from the run's own binary or browser profile (e.g. `mcp-serve`).
 */
export function collectRunProcesses(records, layout, table) {
  const owned = new Map();
  const live = records.filter((record) => isSameProcess(record, table));
  for (const record of live) {
    for (const pid of collectDescendantPids(table, record.pid)) {
      const row = table.find((entry) => entry.pid === pid);
      if (row) owned.set(pid, row);
    }
  }
  const binary = `${join(layout.bin, "cadencr-service")}`;
  const profileFlag = `--user-data-dir=${layout.profile}`;
  for (const row of table) {
    if (row.command.startsWith(binary) || row.command.includes(profileFlag))
      owned.set(row.pid, row);
  }
  for (const pid of ancestorPids(table)) owned.delete(pid);
  return { live, owned: [...owned.values()] };
}

function survivors(rows) {
  const table = readProcessTable();
  return rows.filter((row) => isSameProcess(row, table));
}

function signalRows(rows, signal) {
  for (const row of rows) {
    try {
      process.kill(row.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function waitForExit(rows, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = survivors(rows);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(250);
    remaining = survivors(remaining);
  }
  return remaining;
}

/**
 * SIGTERM the run's process groups (the service then stops its agents itself),
 * wait, then SIGKILL whatever the run still owns. Returns what happened per PID.
 */
export async function stopRunProcesses(records, layout, { graceMs = 15_000 } = {}) {
  const table = readProcessTable();
  const { live, owned } = collectRunProcesses(records, layout, table);
  const skipped = records.filter((record) => !live.includes(record));
  // Only groups the run created (leader = recorded root), never one an
  // ancestor of this command belongs to (a `qa:down` run from inside the run).
  const ancestorGroups = new Set(
    table.filter((row) => ancestorPids(table).has(row.pid)).map((row) => row.pgid),
  );
  const groups = [
    ...new Set(live.filter((record) => record.pgid === record.pid).map((r) => r.pgid)),
  ].filter((pgid) => pgid > 1 && !ancestorGroups.has(pgid));
  signalGroups(groups, "SIGTERM");
  signalRows(
    owned.filter((row) => !groups.includes(row.pgid)),
    "SIGTERM",
  );
  const stubborn = await waitForExit(owned, graceMs);
  signalRows(stubborn, "SIGKILL");
  const remaining = await waitForExit(stubborn, 5_000);
  return { stopped: owned, skipped, killed: stubborn, remaining };
}

/** The `lsof` to run: macOS keeps it outside some PATHs, Linux distributions on PATH. */
export function lsofCommand(exists = existsSync) {
  return exists("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
}

/** PIDs listening on a TCP port (empty when free). Needs `lsof`, like dev:configure-worktree. */
export function listenerPids(port) {
  const result = spawnSync(lsofCommand(), ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  if (result.error) throw new Error(`lsof is required to verify QA ports: ${result.error.message}`);
  // 1 only means "no matching process"; anything else is a failure, never "port free".
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`lsof failed on port ${port}: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Whether every listener on `port` is the recorded process or one of its descendants. */
export function portOwnedBy(port, record) {
  const pids = listenerPids(port);
  if (pids.length === 0) return false;
  const family = collectDescendantPids(readProcessTable(), record.pid);
  return pids.every((pid) => family.has(pid));
}
