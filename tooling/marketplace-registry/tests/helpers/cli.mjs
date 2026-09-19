import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));

export async function bridgeFile(directory, url) {
  const file = path.join(directory, "github-bridge.mjs");
  await writeFile(
    file,
    `
const networkFetch = globalThis.fetch;
const routes = {"raw.githubusercontent.com":"/raw", "github.com":"/public", "api.github.com":"/api", "uploads.github.com":"/uploads", "release-assets.githubusercontent.com":"/cdn"};
globalThis.fetch = async (input, options) => {
  const target = new URL(input);
  if (!routes[target.hostname]) throw new Error("unexpected fixture destination " + target.hostname);
  const result = await networkFetch(${JSON.stringify(url)} + routes[target.hostname] + target.pathname + target.search, options);
  return new Response(result.body, {status: result.status, headers: result.headers});
};
`,
  );
  return file;
}

export function runRegistryCli(bridge, script, args, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", bridge, path.join(scripts, script), ...args],
      {
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          ...(token ? { CADENCR_REGISTRY_GITHUB_TOKEN: token } : {}),
        },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}
