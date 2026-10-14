import { isAbsolute } from "node:path";
import { buildModelConfigOption } from "./pi-models.mjs";
import { validatePiArgs } from "./pi-args.mjs";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { piCommand } from "./acp-server.mjs";

export const DISCOVERY_TIMEOUT_MS = 8_000;
export const MAX_DISCOVERY_BYTES = 1024 * 1024;

export async function discoverModels({ cwd, piArgs = [], env = process.env, clientFactory } = {}) {
  if (!isAbsolute(cwd ?? "")) throw new Error("model discovery needs an absolute cwd");
  validatePiArgs(piArgs);
  const client = clientFactory
    ? clientFactory()
    : new PiRpcClient({
        command: piCommand(env),
        args: ["--mode", "rpc", "--no-session", "--no-approve", ...piArgs],
        cwd,
        env,
      });
  client.on("fatal", () => {});
  client.start();
  try {
    const [models, state] = await Promise.all([
      client.request("get_available_models", {}, DISCOVERY_TIMEOUT_MS),
      client.request("get_state", {}, DISCOVERY_TIMEOUT_MS),
    ]);
    const output = [buildModelConfigOption(models, state)];
    if (Buffer.byteLength(JSON.stringify(output)) > MAX_DISCOVERY_BYTES) {
      throw new Error("Pi model discovery exceeded the 1 MiB output limit");
    }
    return output;
  } finally {
    await client.close();
  }
}
