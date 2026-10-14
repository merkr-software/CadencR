import { fileURLToPath } from "node:url";
import { attachJsonlReader, JsonLineWriter, JsonlFrameLimitError } from "./jsonl.mjs";
import { PiAcpSession } from "./acp-session.mjs";
import { decodeSessionId, normalizeWorkspace } from "./session-identity.mjs";

import { CONNECTOR_VERSION } from "./version.mjs";
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

export class AcpServer {
  constructor({
    input = process.stdin,
    output = process.stdout,
    env = process.env,
    piArgs = [],
  } = {}) {
    this.input = input;
    this.writer = new JsonLineWriter(output, (error) => this.#outputFailed(error));
    this.env = env;
    this.piArgs = piArgs;
    this.sessions = new Map();
    this.pendingClientRequests = new Map();
    this.nextClientRequestId = 0;
    this.extensionPath = fileURLToPath(new URL("./cadencr-permissions.mjs", import.meta.url));
    this.closePromise = null;
    this.closing = false;
    this.pendingSessionOperations = new Set();
    this.cleanupErrors = [];
  }

  run() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const detach = attachJsonlReader(
        this.input,
        (message) => this.#dispatch(message),
        (error) => {
          if (error instanceof JsonlFrameLimitError) finish(error);
          else void this.#replyError(null, -32700, error.message).catch(finish);
        },
      );
      this.detachInput = () => {
        detach();
        this.input.pause();
        this.input.unref?.();
        this.input.off("error", onError);
        this.input.off("end", onEnd);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.close(error ?? new Error("ACP input closed")).then(
          () => (error ? reject(error) : resolve(0)),
          reject,
        );
      };
      this.finishRun = finish;
      const onError = (error) => finish(error);
      const onEnd = () => finish();
      this.input.once("error", onError);
      this.input.once("end", onEnd);
    });
  }

  close(reason = new Error("ACP server closed")) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.detachInput?.();
    this.#rejectPendingClientRequests(reason);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) this.#closeNativeSession(session);
    this.closePromise = Promise.allSettled([...this.pendingSessionOperations]).then(async () => {
      await this.writer.close();
      const errors = this.cleanupErrors;
      if (errors.length) {
        throw new AggregateError(errors, "Pi session cleanup failed");
      }
    });
    return this.closePromise;
  }

  #dispatch(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message !== "object") {
      void this.#replyError(message?.id ?? null, -32600, "invalid JSON-RPC request").catch(
        (error) => this.#outputFailed(error),
      );
      return;
    }
    if (message.method === undefined && message.id !== undefined) {
      this.#clientResponse(message);
      return;
    }
    if (typeof message.method !== "string") {
      void this.#replyError(message.id ?? null, -32600, "JSON-RPC method is required").catch(
        (error) => this.#outputFailed(error),
      );
      return;
    }
    if (this.closing) return;
    const handled = this.#handle(message)
      .catch((error) => {
        if (message.id !== undefined) return this.#replyError(message.id, -32000, error.message);
        process.stderr.write(`pi-cadencr: ${error.message}\n`);
      })
      .catch((error) => this.#outputFailed(error));
    if (["session/new", "session/load", "session/resume"].includes(message.method)) {
      this.#trackSessionOperation(handled);
    }
  }

  async #handle(message) {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        await this.#initialize(message.id, params);
        break;
      case "session/new":
        await this.#newSession(message.id, params);
        break;
      case "session/load":
        await this.#resumeSession(message.id, params);
        break;
      case "session/resume":
        await this.#resumeSession(message.id, params);
        break;
      case "session/set_config_option":
        await this.#setConfig(message.id, params);
        break;
      case "session/prompt":
        await this.#prompt(message.id, params);
        break;
      case "session/cancel":
        await this.#session(params).cancel();
        break;
      case "session/close":
        await this.#closeSession(message.id, params);
        break;
      default:
        if (message.id !== undefined) {
          await this.#replyError(message.id, -32601, `method not found: ${message.method}`);
        }
    }
  }

  async #initialize(id, params) {
    if (params.protocolVersion !== 1) {
      await this.#reply(id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "pi-cadencr", title: "Pi for Cadencr", version: CONNECTOR_VERSION },
      });
      return;
    }
    await this.#reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { resume: {}, close: {} },
      },
      agentInfo: { name: "pi-cadencr", title: "Pi for Cadencr", version: CONNECTOR_VERSION },
    });
  }

  async #newSession(id, params) {
    const session = await this.#openSession(params);
    await this.#registerSession(id, session, true);
  }

  async #resumeSession(id, params) {
    const requestedSessionId = requiredSessionId(params);
    if (this.sessions.has(requestedSessionId)) {
      throw new Error(`Pi session \`${requestedSessionId}\` is already active`);
    }
    const decoded = decodeSessionId(requestedSessionId);
    const requestedCwd = normalizeWorkspace(params.cwd);
    if (decoded.cwd !== requestedCwd) {
      throw new Error(
        `Pi session belongs to \`${decoded.cwd}\`, not requested workspace \`${requestedCwd}\``,
      );
    }
    const session = await this.#openSession(params, decoded.nativeSessionId, requestedSessionId);
    if (session.sessionId !== requestedSessionId) {
      await this.#closeNativeSession(session);
      throw new Error(
        `Pi loaded session \`${session.sessionId}\` instead of \`${requestedSessionId}\``,
      );
    }
    await this.#registerSession(id, session, false);
  }

  async #openSession(params, resumeSessionId, acpSessionId) {
    if (this.closing) throw new Error("ACP server closed");
    if (typeof params.cwd !== "string") throw new Error("ACP session needs a cwd");
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      process.stderr.write(
        `pi-cadencr: Pi RPC does not expose dynamic MCP registration; ignored ${params.mcpServers.length} ACP MCP server(s)\n`,
      );
    }
    const session = await PiAcpSession.create({
      cwd: params.cwd,
      piCommand: piCommand(this.env),
      piArgs: this.piArgs,
      extensionPath: this.extensionPath,
      env: this.env,
      resumeSessionId,
      acpSessionId,
      notify: (method, notificationParams) => this.#notify(method, notificationParams),
      requestPermission: (permissionParams) => this.#requestPermission(permissionParams),
      onCleanupError: (error) => this.cleanupErrors.push(error),
    });
    return session;
  }

  async #registerSession(id, session, includeSessionId) {
    if (this.closing) {
      await this.#closeNativeSession(session);
      throw new Error("ACP server closed during session startup");
    }
    if (this.sessions.has(session.sessionId)) {
      await this.#closeNativeSession(session);
      throw new Error(`duplicate Pi session ID \`${session.sessionId}\``);
    }
    this.sessions.set(session.sessionId, session);
    const result = { configOptions: session.configOptions() };
    if (includeSessionId) result.sessionId = session.sessionId;
    await this.#reply(id, result);
    await session.announce();
  }

  #closeNativeSession(session) {
    return this.#trackSessionOperation(
      Promise.resolve().then(() => session.close()),
      true,
    );
  }

  #trackSessionOperation(operation, cleanup = false) {
    const tracked = operation.catch((error) => {
      if (cleanup) this.cleanupErrors.push(error);
    });
    this.pendingSessionOperations.add(tracked);
    void tracked.then(() => this.pendingSessionOperations.delete(tracked));
    return operation;
  }

  #outputFailed(error) {
    this.finishRun?.(error);
  }

  async #setConfig(id, params) {
    if (typeof params.configId !== "string") throw new Error("configId is required");
    const result = await this.#session(params).setConfig(params.configId, params.value);
    await this.#reply(id, result);
  }

  async #prompt(id, params) {
    const result = await this.#session(params).prompt(params.prompt);
    await this.#reply(id, result);
  }

  async #closeSession(id, params) {
    const session = this.#session(params);
    this.sessions.delete(session.sessionId);
    this.#rejectPendingClientRequests(new Error("Pi session closed"), session.sessionId);
    await this.#closeNativeSession(session);
    await this.#reply(id, {});
  }

  #session(params) {
    const sessionId = requiredSessionId(params);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown Pi session \`${sessionId}\``);
    return session;
  }

  #requestPermission(params) {
    if (this.closing) return Promise.reject(new Error("ACP server closed"));
    const id = `pi-permission-${++this.nextClientRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(id);
        reject(new Error("Cadencr permission request timed out after 30 minutes"));
      }, PERMISSION_TIMEOUT_MS);
      this.pendingClientRequests.set(id, {
        resolve,
        reject,
        timer,
        sessionId: params.sessionId,
      });
      this.writer
        .write({ jsonrpc: "2.0", id, method: "session/request_permission", params })
        .catch((error) => {
          clearTimeout(timer);
          this.pendingClientRequests.delete(id);
          reject(error);
        });
    });
  }

  #clientResponse(message) {
    const id = String(message.id);
    const pending = this.pendingClientRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingClientRequests.delete(id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "permission request failed"));
      return;
    }
    const outcome = message.result?.outcome;
    if (outcome?.outcome === "selected" && typeof outcome.optionId === "string") {
      pending.resolve(outcome.optionId);
    } else {
      pending.resolve(null);
    }
  }

  #reply(id, result) {
    return this.writer.write({ jsonrpc: "2.0", id, result });
  }

  #replyError(id, code, message) {
    return this.writer.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #notify(method, params) {
    return this.writer.write({ jsonrpc: "2.0", method, params });
  }

  #rejectPendingClientRequests(error, sessionId) {
    for (const [id, pending] of this.pendingClientRequests) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingClientRequests.delete(id);
    }
  }
}

export function piCommand(env = process.env) {
  return env.CADENCR_PI_COMMAND || "pi";
}

function requiredSessionId(params) {
  const sessionId = params?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("sessionId is required");
  }
  return sessionId;
}
