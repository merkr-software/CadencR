const TOOL_KINDS = {
  read: "read",
  grep: "search",
  find: "search",
  ls: "read",
  edit: "edit",
  write: "edit",
  bash: "execute",
};

export class PiEventMapper {
  constructor({ sessionId, notify, onSettled, onPermissionUi, onFatal }) {
    this.sessionId = sessionId;
    this.notify = notify;
    this.onSettled = onSettled;
    this.onPermissionUi = onPermissionUi;
    this.onFatal = onFatal;
    this.lastAssistant = null;
  }

  async handle(event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "message_update":
        await this.#messageUpdate(event.assistantMessageEvent);
        break;
      case "message_end":
        this.#messageEnd(event.message);
        break;
      case "tool_execution_start":
        await this.#toolStart(event);
        break;
      case "tool_execution_update":
        await this.#toolUpdate(event);
        break;
      case "tool_execution_end":
        await this.#toolEnd(event);
        break;
      case "agent_end":
        this.#agentEnd(event);
        break;
      case "agent_settled":
        await this.onSettled(this.lastAssistant);
        break;
      case "session_info_changed":
        await this.#rawUpdate("session_info_update", { title: event.name ?? null });
        break;
      case "compaction_start":
        await this.#compaction(event);
        break;
      case "extension_ui_request":
        await this.onPermissionUi(event);
        break;
      case "extension_error":
        this.onFatal(new Error(extensionErrorMessage(event)));
        break;
      default:
        break;
    }
  }

  async commands(commands) {
    const availableCommands = Array.isArray(commands)
      ? commands
          .filter((command) => typeof command?.name === "string" && command.name.length > 0)
          .map(({ name, description, source }) => ({
            name,
            ...(typeof description === "string" ? { description } : {}),
            _meta: { pi: { source } },
          }))
      : [];
    await this.#rawUpdate("available_commands_update", { availableCommands });
  }

  async config(configOptions) {
    await this.#rawUpdate("config_option_update", { configOptions });
  }

  async usage(stats, fallbackContextWindow) {
    const context = stats?.contextUsage;
    const used = integerOrNull(context?.tokens) ?? integerOrNull(stats?.tokens?.input);
    const size = integerOrNull(context?.contextWindow) ?? integerOrNull(fallbackContextWindow);
    if (used === null || size === null || size <= 0) return;
    const cost = Number.isFinite(stats?.cost) ? { amount: stats.cost, currency: "USD" } : undefined;
    await this.#rawUpdate("usage_update", {
      used,
      size,
      ...(cost ? { cost } : {}),
      _meta: { pi: { tokens: stats?.tokens } },
    });
  }

  async modelChanged(value) {
    await this.#rawUpdate("session_info_update", { model: value });
  }

  async #messageUpdate(update) {
    if (!update || typeof update !== "object") return;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      await this.#contentChunk("agent_message_chunk", "text", update.delta);
    } else if (update.type === "thinking_delta" && typeof update.delta === "string") {
      await this.#contentChunk("agent_thought_chunk", "thinking", update.delta);
    }
  }

  #messageEnd(message) {
    if (message?.role !== "assistant") return;
    this.lastAssistant = message;
  }

  #agentEnd(event) {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
    if (assistant) this.lastAssistant = assistant;
  }

  async #toolStart(event) {
    const call = toolDescriptor(event.toolCallId, event.toolName, event.args);
    await this.#rawUpdate("tool_call", {
      ...call,
      status: "in_progress",
    });
  }

  async #toolUpdate(event) {
    const content = resultContent(event.partialResult);
    await this.#rawUpdate("tool_call_update", {
      toolCallId: event.toolCallId,
      status: "in_progress",
      ...(content.length > 0 ? { content } : {}),
    });
  }

  async #toolEnd(event) {
    const content = resultContent(event.result);
    await this.#rawUpdate("tool_call_update", {
      toolCallId: event.toolCallId,
      status: event.isError ? "failed" : "completed",
      ...(content.length > 0 ? { content } : {}),
      rawOutput: event.result ?? null,
    });
  }

  async #compaction(event) {
    await this.#rawUpdate("user_message_chunk", {
      content: {
        type: "compaction",
        auto: event.reason !== "manual",
        reason: event.reason,
      },
    });
  }

  async #contentChunk(sessionUpdate, type, text) {
    if (text.length === 0) return;
    await this.#rawUpdate(sessionUpdate, { content: { type, text } });
  }

  async #rawUpdate(sessionUpdate, body) {
    await this.notify("session/update", {
      sessionId: this.sessionId,
      update: { sessionUpdate, ...body },
    });
  }
}

function toolDescriptor(toolCallId, toolName, args) {
  const kind = TOOL_KINDS[toolName] ?? "other";
  const descriptor = {
    toolCallId,
    toolName,
    title: toolTitle(toolName, args),
    kind,
    rawInput: args ?? null,
  };
  const path = typeof args?.path === "string" ? args.path : null;
  if (path) descriptor.locations = [{ path }];
  return descriptor;
}

function toolTitle(toolName, args) {
  if (toolName === "bash" && typeof args?.command === "string") return args.command;
  if (typeof args?.path === "string") return `${titleCase(toolName)} ${args.path}`;
  return titleCase(toolName || "tool");
}

function titleCase(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resultContent(result) {
  if (Array.isArray(result?.content)) {
    return result.content.flatMap(toAcpContent);
  }
  if (typeof result === "string") return [{ type: "text", text: result }];
  return [];
}

function toAcpContent(block) {
  if (block?.type === "text" && typeof block.text === "string") return [block];
  if (
    block?.type === "image" &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return [block];
  }
  return [];
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function extensionErrorMessage(event) {
  if (typeof event.error === "string") return `Pi extension failed: ${event.error}`;
  if (typeof event.error?.message === "string")
    return `Pi extension failed: ${event.error.message}`;
  if (typeof event.message === "string") return `Pi extension failed: ${event.message}`;
  return "Pi extension failed";
}

export function decodePermissionEnvelope(message) {
  if (typeof message !== "string" || !message.startsWith("CADENCR_PERMISSION:")) return null;
  try {
    const json = Buffer.from(message.slice("CADENCR_PERMISSION:".length), "base64url").toString(
      "utf8",
    );
    const value = JSON.parse(json);
    if (
      typeof value?.toolCallId !== "string" ||
      typeof value?.toolName !== "string" ||
      !value.input ||
      typeof value.input !== "object"
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function permissionToolCall(permission) {
  return toolDescriptor(permission.toolCallId, permission.toolName, permission.input);
}
