import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registryCli } from "./helpers/native-cli.mjs";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(new URL("./", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `tests/${name}`);
if (tests.length === 0) throw new Error("registry test discovery must not be empty");

// Resolve/build once before Node creates independent test workers. A nested
// invocation must not inherit Node's worker marker or its suites may be skipped.
const env = { ...process.env, CADENCR_REGISTRY_TEST_CLI: registryCli() };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...tests], {
  cwd,
  env,
  encoding: "utf8",
  timeout: 180_000,
  maxBuffer: 4 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
