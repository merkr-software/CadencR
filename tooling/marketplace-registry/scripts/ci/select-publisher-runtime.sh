#!/bin/sh
# Trusted exact-commit CI selector; PENDING preserves JS without claiming parity.
set -eu
: "${CLI_ROOT:?CLI_ROOT is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
FETCH_OUTPUT=$(mktemp)
export FETCH_OUTPUT
trap 'rm -f "$FETCH_OUTPUT"' EXIT HUP INT TERM
FETCH_STATUS=0
# Capture only stdout; helper diagnostics remain visible and contain no secrets.
sh scripts/ci/fetch-released-cli.sh ci/released-cli.env "$CLI_ROOT" > "$FETCH_OUTPUT" || FETCH_STATUS=$?
export FETCH_STATUS
node <<'NODE'
const { spawnSync } = require("node:child_process");
const { appendFileSync, lstatSync, realpathSync } = require("node:fs");
const { resolve, join } = require("node:path");
const root = resolve(process.env.CLI_ROOT);
const result = { status: Number(process.env.FETCH_STATUS), stdout: require("node:fs").readFileSync(process.env.FETCH_OUTPUT, "utf8") };
if (result.status === 3 && result.stdout === "") {
  // Explicit PENDING keeps the existing JS publisher active; no parity claim.
  appendFileSync(process.env.GITHUB_OUTPUT, "mode=legacy\n");
} else if (result.status === 0) {
  const file = join(root, "cadencr");
  if (result.stdout !== file + "\n") throw new Error("unexpected verified CLI output");
  const directory = lstatSync(root);
  const metadata = lstatSync(file);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      !metadata.isFile() || metadata.isSymbolicLink() ||
      realpathSync(file) !== file || !(metadata.mode & 0o111)) {
    throw new Error("verified CLI is not an owned executable");
  }
  const help = spawnSync(file, ["registry", "publish-registry", "--help"], {
    stdio: "ignore", timeout: 30 * 1000,
  });
  if (help.error || help.status !== 0) throw new Error("released CLI lacks registry publisher command");
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=released\ncli_file=${file}\n`);
} else {
  throw new Error("released CLI verification failed; refusing legacy fallback");
}
NODE
