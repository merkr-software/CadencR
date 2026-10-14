#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AcpServer } from "./acp-server.mjs";
import { discoverModels } from "./models-command.mjs";
export { buildModelConfigOption } from "./pi-models.mjs";

export { CONNECTOR_VERSION } from "./version.mjs";
import { CONNECTOR_VERSION } from "./version.mjs";

export function parseInvocation(args) {
  const [command, ...rest] = args;
  if (command === "version" && rest.length === 0) return { command };
  if (command === "models") {
    if (
      rest[0] !== "--format" ||
      rest[1] !== "acp-config-options-v1" ||
      rest[2] !== "--cwd" ||
      !rest[3]
    ) {
      throw new Error(
        "usage: provider models --format acp-config-options-v1 --cwd <absolute-path>",
      );
    }
    if (!isAbsolute(rest[3])) throw new Error("models --cwd must be an absolute path");
    return { command, cwd: rest[3], piArgs: rest.slice(4) };
  }
  if (command === "run") {
    if (rest[0] !== "--protocol" || rest[1] !== "acp-v1") {
      throw new Error("usage: provider run --protocol acp-v1");
    }
    return { command, piArgs: rest.slice(2) };
  }
  throw new Error(
    "usage: provider <version|models --format acp-config-options-v1 --cwd PATH|run --protocol acp-v1>",
  );
}

export async function runAcp({
  piArgs = [],
  env = process.env,
  serverFactory,
  forwardSignals = true,
} = {}) {
  const server = serverFactory ? serverFactory({ piArgs, env }) : new AcpServer({ piArgs, env });
  let signalResolve;
  const signalled = new Promise((resolve) => {
    signalResolve = resolve;
  });
  const handlers = new Map();
  if (forwardSignals) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => signalResolve(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  try {
    const result = await Promise.race([server.run(), signalled]);
    if (typeof result === "string") {
      await server.close();
      process.stdin.pause();
      const number = osConstants.signals[result];
      return typeof number === "number" ? 128 + number : 1;
    }
    return result;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

export async function main(args = process.argv.slice(2)) {
  const invocation = parseInvocation(args);
  if (invocation.command === "version") {
    process.stdout.write(`${CONNECTOR_VERSION}\n`);
    return 0;
  }
  if (invocation.command === "models") {
    const configOptions = await discoverModels(invocation);
    process.stdout.write(`${JSON.stringify(configOptions)}\n`);
    return 0;
  }
  return runAcp(invocation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`pi-cadencr: ${error.message}\n`);
    process.exitCode = 1;
  }
}
