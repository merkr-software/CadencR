import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { attachJsonlReader, serializeJsonLine } from "./jsonl.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 64 * 1024;
const SHUTDOWN_TIMEOUT_MS = 1_000;

export class PiRpcClient extends EventEmitter {
  #child;
  #closed = false;
  #commandId = 0;
  #closePromise;
  #pending = new Map();
  #stderr = "";
  #detachReader;

  constructor({ command, args, cwd, env = process.env, spawnImpl = spawn }) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
  }

  start() {
    if (this.#child) throw new Error("Pi RPC client already started");
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdin?.on("error", (error) =>
      this.#fail(new Error(`Pi RPC input failed: ${error.message}${this.#diagnosticSuffix()}`)),
    );
    child.stderr?.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    this.#detachReader = attachJsonlReader(
      child.stdout,
      (message) => this.#handleMessage(message),
      (error) => this.#fail(error),
    );
    child.once("error", (error) => this.#fail(new Error(`could not start Pi: ${error.message}`)));
    child.once("exit", (code, signal) => {
      const detail = signal ?? `status ${code}`;
      this.#fail(new Error(`Pi RPC process exited (${detail})${this.#diagnosticSuffix()}`));
    });
  }

  request(type, params = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.#closed || !this.#child?.stdin) {
      return Promise.reject(new Error("Pi RPC process is not running"));
    }
    const id = `cadencr-pi-${++this.#commandId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi ${type} timed out after ${timeoutMs}ms${this.#diagnosticSuffix()}`));
      }, timeoutMs);
      this.#pending.set(id, { type, resolve, reject, timer });
      this.#write({ id, type }, params).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(new Error(`could not write Pi ${type} request: ${error.message}`));
      });
    });
  }

  respondToExtensionUi(id, response) {
    return this.#write({ type: "extension_ui_response", id }, response);
  }

  getStderr() {
    return this.#stderr;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#detachReader?.();
    this.#rejectAll(new Error("Pi RPC process closed"));
    this.#closePromise = this.#terminate();
    return this.#closePromise;
  }

  async #terminate() {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return;
    child.kill("SIGKILL");
    if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
      throw new Error("Pi RPC process did not exit after SIGKILL");
    }
  }

  #write(header, params) {
    const child = this.#child;
    if (!child?.stdin || this.#closed) return Promise.reject(new Error("Pi RPC stdin is closed"));
    const frame = serializeJsonLine({ ...header, ...params });
    return new Promise((resolve, reject) => {
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }

  #handleMessage(message) {
    if (message?.type === "response" && typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.command !== pending.type) {
        pending.reject(
          new Error(`Pi answered ${pending.type} with a ${String(message.command)} response`),
        );
      } else if (message.success !== true) {
        pending.reject(new Error(`Pi ${pending.type} failed: ${message.error ?? "unknown error"}`));
      } else {
        pending.resolve(message.data);
      }
      return;
    }
    this.emit("event", message);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachReader?.();
    this.#rejectAll(error);
    this.emit("fatal", error);
    this.#closePromise = this.#terminate();
    void this.#closePromise.catch((closeError) => {
      process.stderr.write(`pi-cadencr: could not stop Pi RPC process: ${closeError.message}\n`);
    });
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #diagnosticSuffix() {
    const stderr = this.#stderr.trim();
    return stderr ? `: ${stderr.slice(-4096)}` : "";
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
