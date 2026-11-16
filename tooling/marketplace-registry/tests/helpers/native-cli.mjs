import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
let executable;

// Never skip native coverage or fall back to JavaScript business logic. A copied
// template must supply a verified released binary; a source checkout builds it.
export function registryCli() {
  if (executable) return executable;
  if (process.env.CADENCR_REGISTRY_TEST_CLI) {
    executable = path.resolve(process.env.CADENCR_REGISTRY_TEST_CLI);
  } else {
    accessSync(path.join(repository, "packages/cli/Cargo.toml"));
    const built = spawnSync("pnpm", ["rust", "--", "build", "-p", "cadencr-cli"], {
      cwd: repository,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(built.error);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    executable = path.join(
      repository,
      "target/debug",
      process.platform === "win32" ? "cadencr.exe" : "cadencr",
    );
  }
  accessSync(executable, constants.X_OK);
  return executable;
}

export function runRegistry(args, options = {}) {
  const env = { ...process.env };
  delete env.CADENCR_REGISTRY_GITHUB_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  const result = spawnSync(registryCli(), ["registry", ...args], {
    ...options,
    env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}
