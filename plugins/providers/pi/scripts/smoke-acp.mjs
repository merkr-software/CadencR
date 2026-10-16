import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaClient, stopChild } from "./qa-client.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = resolve(root, "bin/provider");
export async function runSmokeQa({
  env = process.env,
  spawnImpl = spawn,
  execFileImpl = execFile,
} = {}) {
  const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-cadencr-smoke-"));

  process.stderr.write(`Smoke QA scratch files are retained at ${sessionDirectory}\n`);
  const { stdout } = await execFileImpl(
    provider,
    ["models", "--format", "acp-config-options-v1", "--cwd", root],
    { cwd: root, env, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const discoveredModel = JSON.parse(stdout).find((option) => option.category === "model");
  if (!discoveredModel?.options?.length) {
    throw new Error("model discovery did not return a model selector");
  }

  const child = spawnImpl(
    provider,
    ["run", "--protocol", "acp-v1", "--session-dir", sessionDirectory],
    {
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const client = qaClient(child, { timeoutMs: 10_000 });
  const { request } = client;

  try {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "cadencr-pi-smoke", version: "0.4.0" },
    });
    if (initialized.protocolVersion !== 1) {
      throw new Error(`Pi connector negotiated ACP ${initialized.protocolVersion}`);
    }

    const session = await request("session/new", { cwd: root, mcpServers: [] });
    const liveModel = session.configOptions?.find((option) => option.category === "model");
    const discoveredValues = discoveredModel.options.map((option) => option.value);
    const liveValues = liveModel?.options?.map((option) => option.value) ?? [];
    if (JSON.stringify(liveValues) !== JSON.stringify(discoveredValues)) {
      throw new Error("discovered and live Pi model selectors differ");
    }

    await request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: discoveredModel.id,
      value: discoveredModel.currentValue,
    });
    await request("session/close", { sessionId: session.sessionId });

    console.log(
      `ACP v1 communication passed with ${liveValues.length} model(s); isolated session closed`,
    );
  } finally {
    try {
      await stopChild(child);
    } finally {
      client.dispose();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runSmokeQa();
}
