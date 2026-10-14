import { isAbsolute } from "node:path";
import { PiEventMapper, decodePermissionEnvelope, permissionToolCall } from "./acp-events.mjs";
import { buildSessionConfigOptions, modelValue, splitModelValue } from "./pi-models.mjs";
import { runtimeArgs } from "./pi-args.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { encodeSessionId } from "./session-identity.mjs";

const PROMPT_TIMEOUT_MS = 60 * 60 * 1000;
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;

export class PiAcpSession {
  static async create(options) {
    const session = new PiAcpSession(options);
    try {
      await session.#start();
      return session;
    } catch (error) {
      try {
        await session.close();
      } catch (cleanupError) {
        options.onCleanupError?.(cleanupError);
        throw new AggregateError([error, cleanupError], "Pi startup and cleanup failed");
      }
      throw error;
    }
  }

  constructor({
    cwd,
    piCommand,
    piArgs,
    extensionPath,
    env,
    resumeSessionId,
    acpSessionId,
    notify,
    requestPermission,
  }) {
    if (!isAbsolute(cwd)) throw new Error("ACP session cwd must be absolute");
    this.cwd = cwd;
    this.notify = notify;
    this.requestPermission = requestPermission;
    this.resumeSessionId = resumeSessionId;
    this.acpSessionId = acpSessionId;
    this.pendingEvents = [];
    this.eventTail = Promise.resolve();
    this.client = new PiRpcClient({
      command: piCommand,
      args: runtimeArgs(piArgs, extensionPath, resumeSessionId),
      cwd,
      env,
    });
  }

  async #start() {
    this.client.on("event", (event) => this.#queueEvent(event));
    this.client.on("fatal", (error) => this.#fatal(error));
    this.client.start();
    const [availableModels, state, commands, thinkingLevels] = await Promise.all([
      this.client.request("get_available_models"),
      this.client.request("get_state"),
      this.client.request("get_commands"),
      this.client.request("get_available_thinking_levels"),
    ]);
    if (!Array.isArray(availableModels?.models)) {
      throw new Error("Pi returned a malformed model catalog");
    }
    this.availableModels = availableModels;
    this.state = state;
    this.nativeSessionId = state?.sessionId;
    if (this.resumeSessionId && this.nativeSessionId !== this.resumeSessionId) {
      throw new Error(
        `Pi loaded session \`${this.nativeSessionId}\` instead of \`${this.resumeSessionId}\``,
      );
    }
    this.sessionId = this.acpSessionId ?? encodeSessionId(this.cwd, this.nativeSessionId);
    this.thinkingLevels = thinkingLevels?.levels;
    this.mapper = new PiEventMapper({
      sessionId: this.sessionId,
      notify: this.notify,
      onSettled: (assistant) => this.#settled(assistant),
      onPermissionUi: (event) => this.#extensionUi(event),
      onFatal: (error) => this.#fatal(error),
    });
    for (const event of this.pendingEvents.splice(0)) this.#queueEvent(event);
    this.commands = commands?.commands ?? [];
  }

  configOptions() {
    return buildSessionConfigOptions({
      availableModels: this.availableModels,
      state: this.state,
      thinkingLevels: this.thinkingLevels,
    });
  }

  async announce() {
    await this.mapper.commands(this.commands);
    await this.mapper.modelChanged(modelValue(this.state.model));
  }

  async setConfig(configId, value) {
    switch (configId) {
      case "model":
        await this.#setModel(value);
        break;
      case "thinking_level":
        await this.#setThinking(value);
        break;
      case "auto_compaction":
        if (typeof value !== "boolean") throw new Error("auto_compaction must be boolean");
        await this.client.request("set_auto_compaction", { enabled: value });
        break;
      case "steering_mode":
        await this.#setQueueMode("set_steering_mode", value);
        break;
      case "follow_up_mode":
        await this.#setQueueMode("set_follow_up_mode", value);
        break;
      default:
        throw new Error(`unknown Pi session config option \`${String(configId)}\``);
    }
    this.state = await this.client.request("get_state");
    const configOptions = this.configOptions();
    await this.mapper.config(configOptions);
    return { configOptions };
  }

  async prompt(blocks) {
    if (this.activePrompt) throw new Error("Pi already has an active prompt turn");
    const { message, images } = promptInput(blocks);
    if (message.length === 0 && images.length === 0) throw new Error("Pi prompt is empty");
    const completion = deferred(PROMPT_TIMEOUT_MS, "Pi prompt timed out after one hour");
    this.activePrompt = { ...completion, cancelled: false };
    try {
      await this.client.request("prompt", {
        message,
        ...(images.length > 0 ? { images } : {}),
      });
      return await completion.promise;
    } catch (error) {
      this.activePrompt = null;
      completion.cancelTimer();
      throw error;
    }
  }

  async cancel() {
    const prompt = this.activePrompt;
    if (prompt) prompt.cancelled = true;
    try {
      await this.client.request("abort");
    } catch (error) {
      if (prompt && this.activePrompt === prompt) {
        this.activePrompt = null;
        prompt.cancelTimer();
        prompt.reject(error);
      }
    }
  }

  async close() {
    const prompt = this.activePrompt;
    if (prompt) {
      await this.cancel();
      let drainTimeout;
      await Promise.race([
        prompt.promise.catch(() => undefined),
        new Promise((resolvePromise) => {
          drainTimeout = setTimeout(resolvePromise, CLOSE_DRAIN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(drainTimeout);
    }
    if (this.activePrompt) {
      this.activePrompt.cancelTimer();
      this.activePrompt.reject(new Error("Pi session closed"));
      this.activePrompt = null;
    }
    await this.client.close();
  }

  async #setModel(value) {
    const { provider, modelId } = splitModelValue(value);
    const known = this.availableModels.models.some(
      (model) => model.provider === provider && model.id === modelId,
    );
    if (!known) throw new Error(`Pi model \`${value}\` is not available`);
    await this.client.request("set_model", { provider, modelId });
    this.thinkingLevels = (await this.client.request("get_available_thinking_levels"))?.levels;
    await this.mapper.modelChanged(value);
  }

  async #setThinking(value) {
    if (!Array.isArray(this.thinkingLevels) || !this.thinkingLevels.includes(value)) {
      throw new Error(`Pi thinking level \`${String(value)}\` is not available`);
    }
    await this.client.request("set_thinking_level", { level: value });
  }

  async #setQueueMode(command, value) {
    if (value !== "all" && value !== "one-at-a-time") {
      throw new Error(`${command} must be \`all\` or \`one-at-a-time\``);
    }
    await this.client.request(command, { mode: value });
  }

  #queueEvent(event) {
    if (!this.mapper) {
      this.pendingEvents.push(event);
      return;
    }
    this.eventTail = this.eventTail
      .then(() => this.mapper.handle(event))
      .catch((error) => this.#fatal(error));
  }

  async #settled(assistant) {
    const [stats, state] = await Promise.all([
      this.client.request("get_session_stats"),
      this.client.request("get_state"),
    ]);
    await this.mapper.usage(stats, this.state?.model?.contextWindow);
    this.state = state;
    const prompt = this.activePrompt;
    if (!prompt) return;
    this.activePrompt = null;
    prompt.cancelTimer();
    if (prompt.cancelled || assistant?.stopReason === "aborted") {
      prompt.resolve({ stopReason: "cancelled" });
    } else if (assistant?.stopReason === "length") {
      prompt.resolve({ stopReason: "max_tokens" });
    } else if (assistant?.stopReason === "error") {
      prompt.reject(new Error(assistant.errorMessage ?? "Pi model request failed"));
    } else {
      prompt.resolve({ stopReason: "end_turn" });
    }
  }

  async #extensionUi(event) {
    if (event.method === "notify") {
      await this.notify("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `> Pi: ${event.message}\n` },
        },
      });
      return;
    }
    if (event.method === "setTitle" && typeof event.title === "string") {
      await this.notify("session/update", {
        sessionId: this.sessionId,
        update: { sessionUpdate: "session_info_update", title: event.title },
      });
      return;
    }
    if (event.method === "confirm") {
      const embedded = decodePermissionEnvelope(event.message);
      const permission = embedded ?? {
        toolCallId: `pi-ui-${event.id}`,
        toolName: "pi_extension_confirm",
        input: { title: event.title, message: event.message },
      };
      const selected = await this.requestPermission({
        sessionId: this.sessionId,
        toolCall: permissionToolCall(permission),
        options: standardPermissionOptions(),
      });
      await this.client.respondToExtensionUi(event.id, { confirmed: isAllowed(selected) });
      return;
    }
    if (event.method === "select" && Array.isArray(event.options)) {
      const options = event.options.map((name, index) => ({
        optionId: `choice-${index}`,
        name,
        kind: "allow_once",
      }));
      options.push({ optionId: "cancel", name: "Cancel", kind: "reject_once" });
      const selected = await this.requestPermission({
        sessionId: this.sessionId,
        toolCall: permissionToolCall({
          toolCallId: `pi-ui-${event.id}`,
          toolName: "pi_extension_select",
          input: { title: event.title },
        }),
        options,
      });
      const index = Number.parseInt(selected?.replace("choice-", ""), 10);
      if (Number.isInteger(index) && typeof event.options[index] === "string") {
        await this.client.respondToExtensionUi(event.id, { value: event.options[index] });
      } else {
        await this.client.respondToExtensionUi(event.id, { cancelled: true });
      }
      return;
    }
    if (["input", "editor"].includes(event.method)) {
      process.stderr.write(
        `pi-cadencr: Pi extension requested unsupported free-form ${event.method} input\n`,
      );
      await this.client.respondToExtensionUi(event.id, { cancelled: true });
    }
  }

  #fatal(error) {
    if (this.activePrompt) {
      this.activePrompt.cancelTimer();
      this.activePrompt.reject(error);
      this.activePrompt = null;
    }
    process.stderr.write(`pi-cadencr: ${error.message}\n`);
  }
}

function promptInput(blocks) {
  if (!Array.isArray(blocks)) throw new Error("ACP prompt must be an array");
  const text = [];
  const images = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (
      block?.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (block?.type === "resource_link" && typeof block.uri === "string") {
      text.push(`[Attached resource: ${block.name ?? block.uri}](${block.uri})`);
    } else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      text.push(`Attached resource ${block.resource.uri ?? ""}:\n${block.resource.text}`);
    } else {
      throw new Error(`Pi cannot consume ACP prompt block \`${String(block?.type)}\``);
    }
  }
  return { message: text.join("\n\n"), images };
}

function standardPermissionOptions() {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ];
}

function isAllowed(optionId) {
  return optionId === "allow_once";
}

function deferred(timeoutMs, timeoutMessage) {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  return { promise, resolve, reject, cancelTimer: () => clearTimeout(timer) };
}
