import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

test("strict Turbo runs forward telemetry configuration and test gates without Sentry upload credentials", () => {
  const turboDir = path.dirname(createRequire(import.meta.url).resolve("turbo/package.json"));
  const telemetry = {
    CADENCR_SENTRY_DSN: "https://test-key@example.com/1",
    CADENCR_POSTHOG_KEY: "public-test-key",
    CADENCR_POSTHOG_HOST: "https://eu.i.posthog.com",
    CADENCR_TELEMETRY_DEV_ENABLED: "true",
    CADENCR_TELEMETRY_ALLOW_LOCAL_TESTING: "1",
  };
  const dry = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(turboDir, "bin/turbo"),
        "run",
        "build",
        "--filter=@cadencr/service",
        "--env-mode=strict",
        "--dry=json",
      ],
      {
        env: {
          ...process.env,
          ...telemetry,
          SENTRY_AUTH_TOKEN: "upload-token-must-not-pass",
          TURBO_TELEMETRY_DISABLED: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    ),
  );
  assert.equal(dry.envMode, "strict");
  const passed = dry.globalCacheInputs.environmentVariables.passthrough.map(
    (entry) => entry.split("=")[0],
  );
  for (const name of Object.keys(telemetry))
    assert.ok(passed.includes(name), `${name} was filtered`);
  assert.ok(!passed.includes("SENTRY_AUTH_TOKEN"));
  const service = dry.tasks.find((task) => task.taskId === "@cadencr/service#build");
  assert.ok(service);
  assert.equal(
    service.resolvedTaskDefinition.cache,
    false,
    "compiled ingest configuration must not reuse cached builds",
  );
});
