import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/desktop-release.yml", "utf8"));
const config = parse(readFileSync("packages/desktop/electron-builder.yml", "utf8"));
const hook = readFileSync("packages/desktop/build/notarize-app.cjs", "utf8");
const appPath = "/release/Cadencr.app";
const credentials = {
  CADENCR_NOTARIZE_APP: "true",
  APPLE_ID: "release-fixture@example.invalid",
  APPLE_APP_SPECIFIC_PASSWORD: "fixture-password",
  APPLE_TEAM_ID: "FIXTURETEAM",
};

function loadHook(events, failure, env = credentials) {
  const exports = {};
  runInNewContext(hook, {
    exports,
    process: { env },
    console: { log() {} },
    require(name) {
      if (name === "node:path") return { join };
      if (name === "node:fs") return { existsSync: () => true };
      if (name === "@electron/notarize")
        return {
          async notarize(options) {
            assert.equal(options.appPath, appPath);
            events.push("notarize");
            if (failure === "notarize") throw new Error("notary request failed");
          },
        };
      if (name === "node:child_process")
        return {
          execFileSync(command, args) {
            events.push([command, ...Array.from(args)]);
            if (failure === command) throw new Error(`${command} refused the bundle`);
          },
        };
      throw new Error(`Unexpected hook dependency: ${name}`);
    },
  });
  return exports.default;
}

const context = {
  electronPlatformName: "darwin",
  appOutDir: "/release",
  packager: { appInfo: { productFilename: "Cadencr" } },
};
const ticketCheck = ["xcrun", "stapler", "validate", appPath];
const gatekeeperCheck = ["spctl", "--assess", "--type", "execute", "--verbose=4", appPath];

test("one mandatory release hook notarizes, validates the ticket and assesses Gatekeeper", async () => {
  const packaging = workflow.jobs.release.steps.find(
    (step) => step.name === "Build, sign, and notarize desktop app",
  );
  assert.match(packaging.run, /-c[.]mac[.]notarize=false/);
  assert.equal(workflow.jobs.release.env.CADENCR_NOTARIZE_APP, "true");
  assert.equal(config.afterSign, "build/notarize-app.cjs");
  const events = [];
  await loadHook(events)(context);
  assert.deepEqual(events, ["notarize", ticketCheck, gatekeeperCheck]);
});

test("notary, ticket and Gatekeeper failures stop packaging without bypassing the next gate", async () => {
  for (const [failure, expected] of [
    ["notarize", ["notarize"]],
    ["xcrun", ["notarize", ticketCheck]],
    ["spctl", ["notarize", ticketCheck, gatekeeperCheck]],
  ]) {
    const events = [];
    await assert.rejects(loadHook(events, failure)(context));
    assert.deepEqual(events, expected);
  }
  const events = [];
  await assert.rejects(
    loadHook(events, undefined, { CADENCR_NOTARIZE_APP: "true" })(context),
    /Missing notarization credentials/,
  );
  assert.deepEqual(events, []);
});
