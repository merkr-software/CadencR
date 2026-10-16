import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaClient, stopChild } from "./qa-client.mjs";

export const LIVE_QA_COMMAND = "printf PI_RPC_TOOL_OK";

export function liveQaPermission(tool) {
  const input = tool?.rawInput;
  const keys =
    input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  return tool?.toolName === "bash" &&
    input?.command === LIVE_QA_COMMAND &&
    keys.every((key) => key === "command" || key === "timeout") &&
    (input.timeout === undefined ||
      (Number.isFinite(input.timeout) && input.timeout > 0 && input.timeout <= 10))
    ? "allow_once"
    : "reject_once";
}

function requireUpdate(updates, kind, predicate = () => true) {
  if (!updates.some((update) => update?.sessionUpdate === kind && predicate(update))) {
    throw new Error(`live Pi turn did not emit required ACP update \`${kind}\``);
  }
}

function requireToolOutput(updates, permissions) {
  const calls = updates.filter(
    (update) =>
      update?.sessionUpdate === "tool_call" &&
      typeof update.toolCallId === "string" &&
      liveQaPermission(update) === "allow_once" &&
      permissions.some(
        (permission) =>
          permission.toolCallId === update.toolCallId && permission.optionId === "allow_once",
      ),
  );
  requireUpdate(
    updates,
    "tool_call_update",
    (update) =>
      update.status === "completed" &&
      calls.some((call) => call.toolCallId === update.toolCallId) &&
      Array.isArray(update.rawOutput?.content) &&
      update.rawOutput.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") === "PI_RPC_TOOL_OK",
  );
}

export async function runLiveQa({ env = process.env, spawnImpl = spawn } = {}) {
  if (env.CADENCR_PI_LIVE_QA !== "1") {
    throw new Error(
      "Live QA sends real prompts and may incur model costs. Explicitly opt in with CADENCR_PI_LIVE_QA=1.",
    );
  }
  process.stderr.write("WARNING: live Pi QA sends real prompts and may incur model costs.\n");

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const provider = resolve(root, "bin/provider");
  const scratchDirectory = await mkdtemp(join(tmpdir(), "pi-cadencr-live-qa-"));
  const sessionDirectory = join(scratchDirectory, "sessions");
  process.stderr.write(`Live QA scratch files are retained at ${scratchDirectory}\n`);
  await mkdir(sessionDirectory);
  const child = spawnImpl(
    provider,
    ["run", "--protocol", "acp-v1", "--session-dir", sessionDirectory],
    {
      cwd: scratchDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = qaClient(child, { permissionPolicy: liveQaPermission });
  const { request, updates, permissions } = client;

  try {
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "pi-cadencr-live-qa", version: "0.4.0" },
    });
    const session = await request("session/new", { cwd: scratchDirectory, mcpServers: [] });
    const model = session.configOptions.find((option) => option.category === "model");
    const preferred = model.options.find((option) => option.value.endsWith("/gpt-5.6-luna"));
    const selectedModel = preferred?.value ?? model.currentValue;
    await request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value: selectedModel,
    });
    const current = await request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "thinking_level",
      value: "low",
    });
    const thinking = current.configOptions.find((option) => option.id === "thinking_level");
    if (thinking.currentValue !== "low") throw new Error("Pi did not retain low thinking");

    const textStart = updates.length;
    const first = await request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply exactly: PI_RPC_TEXT_OK" }],
    });
    if (first.stopReason !== "end_turn")
      throw new Error(`simple turn stopped as ${first.stopReason}`);

    const text = updates
      .slice(textStart)
      .filter(
        (update) =>
          update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text",
      )
      .map((update) => update.content.text)
      .join("");
    if (text !== "PI_RPC_TEXT_OK") throw new Error("simple turn returned incorrect text");
    const toolStart = updates.length;
    const permissionStart = permissions.length;
    const second = await request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: `You must use the bash tool once to run exactly \`${LIVE_QA_COMMAND}\`, then report its output. Do not read or change any file.`,
        },
      ],
    });
    if (second.stopReason !== "end_turn")
      throw new Error(`tool turn stopped as ${second.stopReason}`);

    requireUpdate(updates, "available_commands_update");
    requireUpdate(updates, "config_option_update");
    requireToolOutput(updates.slice(toolStart), permissions.slice(permissionStart));
    requireUpdate(updates, "usage_update", (update) => update.used >= 0 && update.size > 0);
    await request("session/close", { sessionId: session.sessionId });
    console.log(
      `Live native Pi RPC QA passed with ${selectedModel}: streaming, config, bash permission, tool output, commands, and usage`,
    );
  } finally {
    try {
      await stopChild(child);
    } finally {
      client.dispose();
    }
    // Deliberately preserve all scratch files, including any database created by Pi.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runLiveQa();
}
