import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { runReleaseXcrun } from "./release-xcrun.mjs";

const id = "1b31fe02-05e0-4fd8-b69b-16e0cc85d09d";
const otherId = "2b31fe02-05e0-4fd8-b69b-16e0cc85d09d";
const auth = [
  "--apple-id",
  "fixture@example.invalid",
  "--password",
  "fixture-secret",
  "--team-id",
  "TEAM",
];
const args = [
  "notarytool",
  "submit",
  "/release/Cadencr.zip",
  ...auth,
  "--wait",
  "--output-format",
  "json",
];
const networkFailure = (code = -1009, submission = id) => ({
  status: 1,
  stdout: "",
  stderr: `Error Domain=NSURLErrorDomain Code=${code} NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/${submission}?`,
});
const info = (status = "Accepted", submission = id) => ({
  status: 0,
  stdout: JSON.stringify({ id: submission, status }),
  stderr: "",
});

async function run(responses, command = args) {
  const calls = [];
  const delays = [];
  const result = await runReleaseXcrun(command, {
    invoke(call) {
      calls.push(call);
      assert.ok(responses.length, "unexpected extra Apple command");
      return responses.shift();
    },
    async sleep(delay) {
      delays.push(delay);
    },
  });
  assert.equal(responses.length, 0);
  return { result, calls, delays };
}

test("ordinary xcrun commands and successful submissions pass through unchanged", async () => {
  for (const command of [
    args,
    ["stapler", "validate", "/release/Cadencr.app"],
    ["--find", "notarytool"],
  ]) {
    const original = info();
    const { result, calls, delays } = await run([original], command);
    assert.equal(result, original);
    assert.deepEqual(calls, [command]);
    assert.deepEqual(delays, []);
  }
});

test("a lost status connection queries the same submission without submitting again or leaking credentials", async () => {
  for (const code of [-1001, -1003, -1004, -1005, -1009]) {
    const { result, calls } = await run([
      networkFailure(code),
      info("In Progress"),
      networkFailure(code),
      info(),
    ]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout + result.stderr), { id, status: "Accepted" });
    assert.equal(result.recoveredSubmission, id);
    assert.deepEqual(calls, [
      args,
      ...Array(3).fill(["notarytool", "info", id, ...auth, "--output-format", "json"]),
    ]);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture@example|NSURLError/);
  }
});

test("keychain and API key authentication survive recovery without new uploads", async () => {
  for (const credentials of [
    ["--keychain", "/keys/release", "--keychain-profile", "profile"],
    ["--key", "/keys/key.p8", "--key-id", "KEY", "--issuer", "ISSUER"],
  ]) {
    const command = [
      "notarytool",
      "submit",
      "/release/app.zip",
      ...credentials,
      "--wait",
      "--output-format",
      "json",
    ];
    const { calls } = await run([networkFailure(), info()], command);
    assert.deepEqual(calls[1], [
      "notarytool",
      "info",
      id,
      ...credentials,
      "--output-format",
      "json",
    ]);
  }
});

test("rejections, credentials failures, ambiguous IDs and unsupported invocations cannot trigger recovery", async () => {
  const denied = { status: 1, stdout: "", stderr: "HTTP 401: credentials rejected" };
  const ambiguous = networkFailure();
  ambiguous.stderr += ` https://appstoreconnect.apple.com/notary/v2/submissions/${otherId}?`;
  const missing = networkFailure();
  missing.stderr = missing.stderr.replace(id, "missing");
  const foreign = networkFailure();
  foreign.stderr = foreign.stderr.replace("appstoreconnect.apple.com", "example.invalid");
  for (const [original, command] of [
    [{ ...info("Invalid"), status: 1 }, args],
    [denied, args],
    [networkFailure(-9999), args],
    [ambiguous, args],
    [missing, args],
    [foreign, args],
    [networkFailure(), ["stapler", "staple", "/release/app"]],
    [networkFailure(), [...args, "--unsupported"]],
    [networkFailure(), [...args, "--wait"]],
    [
      networkFailure(),
      ["notarytool", "submit", "/release/app.zip", "--wait", "--output-format", "json"],
    ],
    [networkFailure(), args.filter((arg) => arg !== "--wait")],
  ]) {
    const { result, calls } = await run([original], command);
    assert.equal(result, original);
    assert.deepEqual(calls, [command]);
  }
});

test("only Accepted for the matching submission permits success, including on the final query", async () => {
  for (const terminal of [
    info("Invalid"),
    info("Rejected"),
    info("Unknown"),
    info("Accepted", otherId),
    { status: 0, stdout: "not JSON", stderr: "" },
    { status: 1, stdout: "", stderr: "HTTP 403" },
  ]) {
    const { result, calls } = await run([networkFailure(), terminal]);
    assert.notEqual(result.status, 0);
    assert.equal(result.recoveredSubmission, undefined);
    assert.equal(calls.length, 2);
  }
  const { result, delays } = await run([
    networkFailure(),
    info("In Progress"),
    networkFailure(),
    info("In Progress"),
    info("In Progress"),
    info(),
  ]);
  assert.equal(result.status, 0);
  assert.deepEqual(delays, [0, 10_000, 20_000, 40_000, 60_000]);
});

test("five failed or pending status queries stop publication without a second submit", async () => {
  for (const pending of [info("In Progress"), networkFailure()]) {
    const { result, calls, delays } = await run([networkFailure(), ...Array(5).fill(pending)]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery exhausted; publication stopped/);
    assert.equal(calls.length, 6);
    assert.equal(calls.filter((call) => call[1] === "submit").length, 1);
    assert.equal(delays.length, 5);
  }
});

test("the workflow loads the wrapper from its immutable commit and installs a transparent argument shim", () => {
  const workflow = parse(readFileSync(".github/workflows/desktop-release.yml", "utf8"));
  const setup = workflow.jobs.release.steps.find(
    (step) => step.name === "Enable recovery of interrupted Apple notarization status polling",
  );
  const scratch = mkdtempSync(join(tmpdir(), "cadencr-notary-wrapper-"));
  try {
    const fixture = "process.stdout.write(JSON.stringify(process.argv.slice(2)));";
    writeFileSync(
      join(scratch, "gh"),
      '#!/bin/sh\nprintf "%s" "$*" > "$GH_CALLS"\nprintf "%s" "$FIXTURE_BASE64"\nexit "$GH_EXIT"\n',
      { mode: 0o700 },
    );
    const envFile = join(scratch, "env");
    const pathFile = join(scratch, "path");
    const env = {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      RUNNER_TEMP: scratch,
      GITHUB_ENV: envFile,
      GITHUB_PATH: pathFile,
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_SHA: "abc123",
      GH_CALLS: join(scratch, "calls"),
      GH_EXIT: "0",
      FIXTURE_BASE64: Buffer.from(fixture).toString("base64"),
    };
    delete env.BASH_ENV;
    const installed = spawnSync("bash", ["-e", "-c", setup.run], { env, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(
      readFileSync(join(scratch, "calls"), "utf8"),
      "api repos/fixture/repo/contents/scripts/release-xcrun.mjs?ref=abc123 --jq .content",
    );
    const wrapper = join(scratch, "cadencr-notary-tools/release-xcrun.mjs");
    assert.equal(readFileSync(wrapper, "utf8"), fixture);
    assert.equal(readFileSync(envFile, "utf8"), `CADENCR_XCRUN_WRAPPER=${wrapper}\n`);
    assert.equal(readFileSync(pathFile, "utf8"), `${join(scratch, "cadencr-notary-tools")}\n`);
    const delegated = spawnSync(
      join(scratch, "cadencr-notary-tools/xcrun"),
      ["notarytool", "info", "argument with spaces"],
      { env: { ...env, CADENCR_XCRUN_WRAPPER: wrapper }, encoding: "utf8" },
    );
    assert.equal(delegated.status, 0, delegated.stderr);
    assert.deepEqual(JSON.parse(delegated.stdout), ["notarytool", "info", "argument with spaces"]);
    const failed = spawnSync("bash", ["-e", "-c", setup.run], {
      env: { ...env, GH_EXIT: "17" },
      encoding: "utf8",
    });
    assert.equal(failed.status, 17, failed.stderr);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
