#!/usr/bin/env node
// `npm run build:backend`: builds the native backend (the Rust crate in
// backend/) in release mode and copies it to the path tab.json's
// `backend.binary` names for its platform.
//
// The platform is the one the binary is built for — the Rust host, or the
// `--target <triple>` passed through (`npm run build:backend -- --target
// x86_64-apple-darwin`, after `rustup target add x86_64-apple-darwin`).
// `--locked` is passed on to cargo.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Rust target triple → `backend.binary` key (docs/TAB_BACKEND_PROTOCOL.md §2.1). */
const PLATFORMS = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "x86_64-unknown-linux-musl": "linux-x86_64",
};

function fail(message) {
  console.error(`build:backend: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    fail(
      result.error.code === "ENOENT"
        ? `${command} is not installed; install Rust from https://rustup.rs`
        : `cannot run ${command}: ${result.error.message}`,
    );
  }
  if (result.status !== 0)
    fail(`${command} ${args.join(" ")} failed (status ${result.status ?? result.signal})`);
  return result.stdout;
}

/** `--target <triple>` or `--target=<triple>` from the arguments, else the Rust host triple. */
function targetTriple(args) {
  const inline = args.find((arg) => arg.startsWith("--target="));
  if (inline) return { triple: inline.slice("--target=".length), explicit: true };
  const index = args.indexOf("--target");
  if (index !== -1) {
    if (!args[index + 1]) fail("--target needs a triple");
    return { triple: args[index + 1], explicit: true };
  }
  const host = /^host: (\S+)$/m.exec(run("rustc", ["-vV"]))?.[1];
  if (!host) fail("cannot tell the Rust host triple from `rustc -vV`");
  return { triple: host, explicit: false };
}

/** The `bin` executable cargo reports building, from its JSON messages. */
function builtExecutable(messages) {
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (
      message.reason === "compiler-artifact" &&
      message.target?.kind?.includes("bin") &&
      message.executable
    ) {
      return message.executable;
    }
  }
  return fail("cargo did not report building a binary");
}

const args = process.argv.slice(2);
const { triple, explicit } = targetTriple(args);
const platform = PLATFORMS[triple];
if (!platform)
  fail(
    `${triple} is not a platform custom tab backends run on (${Object.keys(PLATFORMS).join(", ")})`,
  );
const declared = JSON.parse(readFileSync(join(root, "tab.json"), "utf8")).backend?.binary?.[
  platform
];
if (typeof declared !== "string") fail(`tab.json declares no backend.binary.${platform}`);

const cargoArgs = ["build", "--release", "--manifest-path", join(root, "backend", "Cargo.toml")];
if (explicit) cargoArgs.push("--target", triple);
if (args.includes("--locked")) cargoArgs.push("--locked");
cargoArgs.push("--message-format=json-render-diagnostics");
// stdout carries cargo's JSON messages; its progress and diagnostics go to stderr.
const executable = builtExecutable(
  run("cargo", cargoArgs, { stdio: ["inherit", "pipe", "inherit"] }),
);

const destination = join(root, declared);
mkdirSync(dirname(destination), { recursive: true });
// A new file, never the old one overwritten in place: macOS caches the code
// signature of an executable it has run, and kills (SIGKILL) a rewritten
// file at the same inode on its next launch.
rmSync(destination, { force: true });
copyFileSync(executable, destination);
chmodSync(destination, 0o755);
console.log(`${relative(root, destination)} ← ${executable}`);
