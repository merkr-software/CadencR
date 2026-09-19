#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { canonicalJson } from "./lib.mjs";
import { readBoundedRegularFile } from "./publication/io.mjs";
import { signIndexPayload } from "./publication/signing.mjs";

const PAYLOAD_LIMIT = 32 * 1024 * 1024;
const USAGE = "usage: sign-index.mjs --payload FILE --private-key FILE --key-id ID --output FILE";

function parseArgs(argv) {
  const names = new Set(["--payload", "--private-key", "--key-id", "--output"]);
  if (argv.length !== names.size * 2) throw new Error(USAGE);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || values.has(name) || !value || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values.set(name, value);
  }
  if (values.size !== names.size) throw new Error(USAGE);
  return {
    payload: values.get("--payload"),
    privateKey: values.get("--private-key"),
    keyId: values.get("--key-id"),
    output: values.get("--output"),
  };
}

function parsePayload(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("payload must be valid JSON");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloadBytes = await readBoundedRegularFile(args.payload, PAYLOAD_LIMIT, "payload");
  const signed = parsePayload(payloadBytes);
  const envelope = await signIndexPayload(signed, {
    privateKeyFile: args.privateKey,
    keyId: args.keyId,
  });
  await writeFile(args.output, `${canonicalJson(envelope)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`wrote signed index: ${args.output}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unexpected failure";
  console.error(`sign-index: ${message}`);
  process.exitCode = 1;
});
