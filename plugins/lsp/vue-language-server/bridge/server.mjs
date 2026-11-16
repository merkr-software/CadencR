// Self-contained Vue 3 / TypeScript transport adapter, without app identity checks.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { frames, write, TypeScriptConnection } from "./framing.mjs";
import { FALLBACK_METHODS, fallback, empty, applyDocumentChanges } from "./typescript-features.mjs";

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documents = new Map();
const diagnostics = new Map();
const featureRequests = new Map();
let projectRoot;
let closing = false;
let child;
let ts;
const shutdownTimers = new Map();

function cleanup(graceful = false) {
  if (closing) return;
  closing = true;
  ts?.dispose();
  for (const process of [child, typeScript]) {
    if (!process) continue;
    if (!process.stdin.destroyed) process.stdin.end();
    if (process.exitCode !== null) continue;
    const terminate = () => {
      if (process.exitCode === null) process.kill("SIGTERM");
      shutdownTimers.set(process, setTimeout(() => {
        if (process.exitCode === null) process.kill("SIGKILL");
      }, 1000));
    };
    if (graceful) shutdownTimers.set(process, setTimeout(terminate, 3000));
    else terminate();
  }
}

function fail(error) {
  // Child termination may close a partially written frame during cancellation.
  if (closing) return;
  process.stderr.write(`Vue bridge: ${error.message}\n`);
  cleanup();
  process.exitCode = 1;
  process.stdin.destroy();
}

function publish(uri) {
  const entries = diagnostics.get(uri);
  if (!entries) return;
  const combined = Object.values(entries).flat();
  return write(process.stdout, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: combined } });
}

function typeScriptEvent(message) {
  if (!["syntaxDiag", "semanticDiag", "suggestionDiag"].includes(message.event)) return;
  const { file, diagnostics: items } = message.body;
  const uri = pathToFileURL(file).href;
  if (!documents.has(uri)) return;
  const entries = diagnostics.get(uri) ?? {};
  entries[message.event] = items.map((item) => ({
    range: { start: { line: item.start.line - 1, character: item.start.offset - 1 },
      end: { line: item.end.line - 1, character: item.end.offset - 1 } },
    severity: item.category === "error" ? 1 : item.category === "warning" ? 2 : 3,
    code: item.code, source: "vue-typescript", message: item.text,
  }));
  diagnostics.set(uri, entries);
  return publish(uri);
}

const typeScript = spawn(process.execPath, [resolve(bundle, "node_modules/typescript/lib/tsserver.js"),
  "--globalPlugins", "@vue/typescript-plugin", "--pluginProbeLocations", bundle,
  "--allowLocalPluginLoads", "--useInferredProjectPerProjectRoot", "--disableAutomaticTypingAcquisition"],
{ stdio: ["pipe", "pipe", "inherit"], env: process.env });
typeScript.on("error", fail);
typeScript.stdin.on("error", (error) => { if (!closing) fail(error); });
typeScript.on("exit", (code) => {
  clearTimeout(shutdownTimers.get(typeScript));
  if (!closing) fail(new Error(`TypeScript exited ${code}`));
});
ts = new TypeScriptConnection(typeScript, typeScriptEvent, fail);

function fromClient(message) {
  if (FALLBACK_METHODS.has(message.method) && message.id !== undefined) {
    if (featureRequests.size >= 256) throw new Error("Too many pending language-feature requests");
    featureRequests.set(message.id, message);
  }
  if (message.method === "initialize") {
    projectRoot = message.params.rootUri ? fileURLToPath(message.params.rootUri) : process.cwd();
  }
  if (message.method === "textDocument/didOpen") {
    const document = message.params.textDocument;
    documents.set(document.uri, { text: document.text });
    const file = fileURLToPath(document.uri);
    ts.notify("open", { file, fileContent: document.text, projectRootPath: projectRoot });
    ts.notify("geterr", { delay: 0, files: [file] });
  }
  if (message.method === "textDocument/didChange") {
    const uri = message.params.textDocument.uri;
    const document = documents.get(uri);
    if (document) {
      const file = fileURLToPath(uri);
      applyDocumentChanges(ts, file, document, message.params.contentChanges);
      ts.notify("geterr", { delay: 0, files: [file] });
    }
  }
  if (message.method === "textDocument/didClose") {
    const uri = message.params.textDocument.uri;
    ts.notify("close", { file: fileURLToPath(uri) });
    documents.delete(uri);
    diagnostics.delete(uri);
  }
  return Promise.all([ts.flush(), write(child.stdin, message)]);
}

function fromVue(message) {
  if (message.id !== undefined && !message.method && featureRequests.has(message.id)) {
    const request = featureRequests.get(message.id);
    featureRequests.delete(message.id);
    if (!message.error && empty(message.result)) {
      return fallback(ts, request).then((result) => write(process.stdout, { ...message, result: result ?? message.result }))
        .catch((error) => write(process.stdout, { jsonrpc: "2.0", id: message.id,
          error: { code: -32603, message: error.message } }));
    }
  }
  if (message.method === "tsserver/request") {
    const nested = message.params.length === 1 && Array.isArray(message.params[0]);
    const [id, command, args] = nested ? message.params[0] : message.params;
    if (!Number.isSafeInteger(id) || typeof command !== "string") throw new Error("Invalid Vue TypeScript bridge request");
    return ts.request(command, args).then((response) => {
      return write(child.stdin, { jsonrpc: "2.0", method: "tsserver/response", params: nested ? [[id, response]] : [id, response] });
    }).catch((error) => { if (!closing) fail(error); });
  }
  if (message.method === "textDocument/publishDiagnostics") {
    const { uri, diagnostics: items } = message.params;
    const entries = diagnostics.get(uri) ?? {};
    entries.vue = items;
    diagnostics.set(uri, entries);
    return publish(uri);
  }
  return write(process.stdout, message);
}

async function start() {
  await ts.request("configure", { hostInfo: "cadencr-vue-bundle",
    extraFileExtensions: [{ extension: ".vue", isMixedContent: true, scriptKind: 7 }],
    preferences: { includeCompletionsForModuleExports: true } });
  child = spawn(process.execPath, [resolve(bundle, "node_modules/@vue/language-server/bin/vue-language-server.js"), "--stdio"],
    { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  child.on("error", fail);
  child.stdin.on("error", (error) => { if (!closing) fail(error); });
  child.on("exit", (code) => {
    cleanup();
    clearTimeout(shutdownTimers.get(child));
    process.exitCode = code ?? 1;
    process.stdin.destroy();
  });
  frames(child.stdout, fromVue, fail);
  frames(process.stdin, fromClient, fail);
  process.stdin.on("end", () => cleanup(true));
}

process.on("SIGTERM", () => { cleanup(); process.stdin.destroy(); });
process.on("SIGINT", () => { cleanup(); process.stdin.destroy(); });
process.on("exit", () => cleanup());
start().catch(fail);
