import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const retryDelays = [0, 10_000, 20_000, 40_000, 60_000];
const authFlags = new Set([
  "--apple-id",
  "--password",
  "--team-id",
  "--key",
  "--key-id",
  "--issuer",
  "--keychain-profile",
  "--keychain",
]);
const submissionUrl =
  /https:\/\/appstoreconnect\.apple\.com\/notary\/v2\/submissions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[?\s,}"']|$)/gi;

function transientNetworkFailure(result) {
  return (
    result.status !== 0 &&
    /NSURLErrorDomain\s+Code=-(?:1001|1003|1004|1005|1009)\b/.test(
      `${result.stdout}\n${result.stderr}`,
    )
  );
}

function recoveryRequest(args, result) {
  if (args[0] !== "notarytool" || args[1] !== "submit" || !transientNetworkFailure(result)) return;
  const ids = new Set(
    Array.from(`${result.stdout}\n${result.stderr}`.matchAll(submissionUrl), (match) =>
      match[1].toLowerCase(),
    ),
  );
  if (ids.size !== 1) return;
  const auth = [];
  const seen = new Set();
  let wait = false;
  let json = false;
  for (let index = 3; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) return;
    seen.add(flag);
    if (flag === "--wait") {
      wait = true;
      continue;
    }
    if (flag === "--output-format" && args[index + 1] === "json") {
      json = true;
      index++;
      continue;
    }
    if (!authFlags.has(flag) || !args[index + 1] || args[index + 1].startsWith("--")) return;
    auth.push(flag, args[++index]);
  }
  const authenticated =
    seen.has("--keychain-profile") ||
    ["--apple-id", "--password", "--team-id"].every((flag) => seen.has(flag)) ||
    ["--key", "--key-id"].every((flag) => seen.has(flag));
  if (wait && json && authenticated) return { id: Array.from(ids)[0], auth };
}

function invokeXcrun(args) {
  const result = spawnSync("/usr/bin/xcrun", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // A status lookup is read-only and must not hang until the whole job expires.
    timeout: args[0] === "notarytool" && args[1] === "info" ? 120_000 : undefined,
  });
  if (result.error)
    throw new Error(`Unable to run Apple's xcrun (${result.error.code ?? "unknown error"})`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Submit exactly once. A lost polling connection may only resume read-only
// status queries for the same submission; Apple must explicitly accept it.
export async function runReleaseXcrun(args, { invoke = invokeXcrun, sleep = setTimeout } = {}) {
  const original = invoke(args);
  const request = recoveryRequest(args, original);
  if (!request) return original;
  for (const delay of retryDelays) {
    await sleep(delay);
    const result = invoke([
      "notarytool",
      "info",
      request.id,
      ...request.auth,
      "--output-format",
      "json",
    ]);
    if (transientNetworkFailure(result)) continue;
    if (result.status !== 0) return result;
    let info;
    try {
      info = JSON.parse(result.stdout);
    } catch {
      return {
        status: 1,
        stdout: "",
        stderr: "Apple returned malformed notarization status JSON.\n",
      };
    }
    if (!info || typeof info.id !== "string" || info.id.toLowerCase() !== request.id) {
      return {
        status: 1,
        stdout: "",
        stderr: "Apple returned a different notarization submission ID.\n",
      };
    }
    if (info.status === "Accepted") {
      // @electron/notarize parses combined stdout/stderr as JSON. Emit only
      // the verified response, never the original transient error or arguments.
      return {
        status: 0,
        stdout: JSON.stringify({ id: request.id, status: "Accepted" }),
        stderr: "",
        recoveredSubmission: request.id,
      };
    }
    if (info.status !== "In Progress") {
      return {
        status: 1,
        stdout: JSON.stringify(info),
        stderr: "Apple did not accept the notarization submission.\n",
      };
    }
  }
  return {
    ...original,
    stderr: `${original.stderr}\nNotarization status recovery exhausted; publication stopped.\n`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReleaseXcrun(process.argv.slice(2));
    if (result.recoveredSubmission && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nApple notarization status recovered: \`${result.recoveredSubmission}\` — Accepted.\n`,
      );
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
