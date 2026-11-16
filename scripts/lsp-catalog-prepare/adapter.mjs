// Data-driven stdio adapter. No server identity or app-specific dispatch exists here.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { frames, write } from "./framing.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const bundle = resolve(directory, "..");
const config = JSON.parse(readFileSync(resolve(directory, "config.json"), "utf8"));
let root = process.cwd();
let rootUri;
let closing = false;
let sequence = 0;
const pending = new Map();
let shutdownTimer;

if (config.node_engine_ranges) {
  const semver = createRequire(import.meta.url)("semver");
  const rejected = config.node_engine_ranges.filter((range) => !semver.satisfies(process.versions.node, range));
  if (rejected.length) {
    process.stderr.write(`Unsupported Node.js ${process.versions.node}. ${config.node_engine_error ?? "Select a supported Node runtime."} Unmet dependency engines: ${rejected.join(" AND ")}\n`);
    process.exit(1);
  }
}

function merge(defaults, provided) {
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return provided ?? defaults;
  const result = Object.create(null);
  for (const [key, value] of Object.entries(defaults)) result[key] = value;
  if (provided && typeof provided === "object" && !Array.isArray(provided)) {
    for (const [key, value] of Object.entries(provided)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe configuration key");
      result[key] = merge(defaults[key], value);
    }
  }
  return result;
}

function expand(value) {
  if (typeof value === "string") return value.replaceAll("${bundle}", bundle).replaceAll("${workspace}", root)
    .replaceAll("${workspaceUri}", rootUri ?? "");
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  return value;
}

const child = spawn(process.execPath, [resolve(bundle, config.entry), ...config.args],
  { stdio: ["pipe", "pipe", "inherit"], env: process.env });

function cleanup(graceful = false) {
  if (closing) return;
  closing = true;
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  if (!child.stdin.destroyed) child.stdin.end();
  if (child.exitCode === null) {
    const terminate = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      shutdownTimer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1000);
    };
    if (graceful) shutdownTimer = setTimeout(terminate, 3000);
    else terminate();
  }
}

function fail(error) {
  // Expected pipe closures after shutdown starts do not replace the child exit code.
  if (closing) return;
  process.stderr.write(`LSP adapter: ${error.message}\n`);
  cleanup();
  process.exitCode = 1;
  process.stdin.destroy();
}

function fromClient(message) {
  if (message.method === "initialize") {
    rootUri = message.params.rootUri ?? message.params.workspaceFolders?.[0]?.uri;
    if (rootUri) root = fileURLToPath(rootUri);
    message.params.initializationOptions = merge(expand(config.initialization_options ?? {}), message.params.initializationOptions);
  }
  const waiter = pending.get(message.id);
  if (waiter && !message.method) {
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) return write(child.stdin, { ...message, id: waiter.id });
    const values = Array.isArray(message.result) ? message.result : [];
    const result = waiter.items.map((item, index) => merge(expand(config.workspace_configuration?.[item.section ?? ""] ?? {}), values[index]));
    return write(child.stdin, { jsonrpc: "2.0", id: waiter.id, result });
  }
  return write(child.stdin, message);
}

function fromServer(message) {
  if (message.method === "workspace/configuration" && config.workspace_configuration) {
    if (pending.size >= 256) throw new Error("Too many configuration requests");
    const id = `cadencr-adapter-config-${++sequence}`;
    const timer = setTimeout(() => fail(new Error("Host configuration response timed out")), 20000);
    pending.set(id, { id: message.id, items: message.params.items, timer });
    return write(process.stdout, { ...message, id });
  }
  return write(process.stdout, message);
}

child.on("error", fail);
child.stdin.on("error", (error) => { if (!closing) fail(error); });
child.on("exit", (code) => {
  cleanup();
  clearTimeout(shutdownTimer);
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
frames(process.stdin, fromClient, fail);
frames(child.stdout, fromServer, fail);
process.stdin.on("end", () => cleanup(true));
process.on("SIGINT", () => { cleanup(); process.stdin.destroy(); });
process.on("SIGTERM", () => { cleanup(); process.stdin.destroy(); });
process.on("exit", () => cleanup());
