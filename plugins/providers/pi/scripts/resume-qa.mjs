import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaClient, stopChild } from "./qa-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = resolve(root, "bin/provider");

export async function runResumeQa({ env = process.env, spawnImpl = spawn } = {}) {
  if (env.CADENCR_PI_LIVE_QA !== "1") {
    throw new Error(
      "Live QA sends real prompts and may incur model costs. Explicitly opt in with CADENCR_PI_LIVE_QA=1.",
    );
  }
  process.stderr.write("WARNING: live Pi QA sends real prompts and may incur model costs.\n");

  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-cadencr-live-resume-"));
  process.stderr.write(`Resume QA scratch files are retained at ${sessionDirectory}\n`);
  const codeword = `PI_RPC_RESUME_${Date.now()}`;
  let first;
  let resumed;

  try {
    first = startClient(sessionDirectory, { env, spawnImpl });
    const initialized = await first.request("initialize", initializeParams());
    if (initialized.agentCapabilities?.sessionCapabilities?.resume == null) {
      throw new Error("Pi connector did not advertise ACP session/resume");
    }
    const session = await first.request("session/new", { cwd: root, mcpServers: [] });
    const selectedModel = await selectEconomicalModel(first, session);
    const remembered = await first.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: `Remember this exact codeword for the next turn: ${codeword}. Reply only ACK.`,
        },
      ],
    });
    if (remembered.stopReason !== "end_turn") {
      throw new Error(`Pi memory turn stopped as ${remembered.stopReason}`);
    }
    await first.stop();
    first = null;

    resumed = startClient(sessionDirectory, { env, spawnImpl });
    await resumed.request("initialize", initializeParams());
    const loaded = await resumed.request("session/resume", {
      sessionId: session.sessionId,
      cwd: root,
      mcpServers: [],
    });
    const model = loaded.configOptions?.find((option) => option.category === "model");
    if (!model?.options?.some((option) => option.value === selectedModel)) {
      throw new Error("resumed Pi session did not restore its model catalog");
    }
    const updateStart = resumed.updates.length;
    const recalled = await resumed.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply only with the exact codeword from my previous turn." }],
    });
    if (recalled.stopReason !== "end_turn") {
      throw new Error(`Pi recall turn stopped as ${recalled.stopReason}`);
    }
    const resumedText = resumed.updates
      .slice(updateStart)
      .filter((update) => update?.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content?.text ?? "")
      .join("");
    if (!resumedText.includes(codeword)) {
      throw new Error(`Pi lost context after connector restart; response was ${resumedText}`);
    }
    console.log(
      `Live Pi durable-resume QA passed with ${selectedModel} and session ${session.sessionId}`,
    );
  } finally {
    await first?.stop();
    await resumed?.stop();
  }
}

function initializeParams() {
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "pi-cadencr-resume-qa", version: "0.4.0" },
  };
}

async function selectEconomicalModel(client, session) {
  const model = session.configOptions?.find((option) => option.category === "model");
  if (!model?.options?.length) throw new Error("Pi session returned no model selector");
  const preferred = model.options.find((option) => option.value.endsWith("/gpt-5.6-luna"));
  const selected = preferred?.value ?? model.currentValue;
  await client.request("session/set_config_option", {
    sessionId: session.sessionId,
    configId: model.id,
    value: selected,
  });
  return selected;
}

function startClient(sessionDirectoryPath, { env, spawnImpl }) {
  const child = spawnImpl(
    provider,
    ["run", "--protocol", "acp-v1", "--session-dir", sessionDirectoryPath],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const client = qaClient(child, { timeoutMs: 180_000 });
  return {
    request: client.request,
    updates: client.updates,
    async stop() {
      try {
        await stopChild(child);
      } finally {
        client.dispose();
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runResumeQa();
}
