import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { attachJsonlReader } from "../src/jsonl.mjs";
import { validatePiArgs } from "../src/pi-args.mjs";
import { AcpServer } from "../src/acp-server.mjs";
import { CONNECTOR_VERSION } from "../src/version.mjs";

test("JSONL bounds complete and unterminated UTF-8 frames", () => {
  for (const text of ["x".repeat(17), `${JSON.stringify("é".repeat(9))}\n`]) {
    const stream = new PassThrough();
    const errors = [];
    const messages = [];
    attachJsonlReader(
      stream,
      (value) => messages.push(value),
      (error) => errors.push(error),
      16,
    );
    stream.write(text);
    stream.write("{}\n");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /exceeds 16 bytes/);
    assert.deepEqual(messages, []);
  }
});
test("permission plumbing cannot be overridden by descriptor arguments", () => {
  for (const flag of [
    "--approve",
    "-a",
    "--no-approve",
    "-na",
    "--extension",
    "-e",
    "--no-extensions",
    "-ne",
    "--",
  ]) {
    assert.throws(() => validatePiArgs([flag]), /conflicts/);
    assert.throws(() => validatePiArgs([`${flag}=value`]), /conflicts/);
  }
});
test("server cleanup surfaces child failure", async () => {
  const server = new AcpServer({ input: new PassThrough(), output: new PassThrough() });
  server.sessions.set("fake", {
    close: async () => {
      throw new Error("child stuck");
    },
  });
  await assert.rejects(server.close(), /cleanup failed/);
  await assert.rejects(server.close(), /cleanup failed/);
});
test("live scripts require opt-in before starting Pi", () => {
  for (const script of ["live-qa.mjs", "resume-qa.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [new URL(`../scripts/${script}`, import.meta.url).pathname],
      {
        env: { ...process.env, CADENCR_PI_LIVE_QA: "", CADENCR_PI_COMMAND: "/nonexistent/pi" },
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /may incur model costs/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
test("runtime package and handshake share version", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(metadata.version, CONNECTOR_VERSION);
});

test("JSONL frame budget applies individually and preserves fragmented UTF-8", () => {
  const stream = new PassThrough();
  const values = [];
  const errors = [];
  attachJsonlReader(
    stream,
    (value) => values.push(value),
    (error) => errors.push(error),
    16,
  );
  const bytes = Buffer.from('"é"\n"é"\n"é"\n"é"\n');
  stream.write(bytes.subarray(0, 2));
  stream.write(bytes.subarray(2));
  assert.deepEqual(values, ["é", "é", "é", "é"]);
  assert.deepEqual(errors, []);
});

test("oversized ACP connection closes sessions and rejects pending permission promises", async () => {
  const input = new PassThrough();
  const server = new AcpServer({ input, output: new PassThrough() });
  let closed = false;
  let rejected;
  server.sessions.set("fake", {
    close: async () => {
      closed = true;
    },
  });
  const permission = new Promise((resolve, reject) => {
    rejected = reject;
  });
  server.pendingClientRequests.set("fake", {
    reject: rejected,
    timer: setTimeout(() => {}, 10000),
  });
  const run = server.run();
  const runCheck = assert.rejects(run, /frame exceeds/);
  const permissionCheck = assert.rejects(permission, /frame exceeds/);
  input.write("x".repeat(16 * 1024 * 1024 + 1));
  await Promise.all([runCheck, permissionCheck]);
  assert.equal(closed, true);
  assert.equal(server.sessions.size, 0);
  assert.equal(server.pendingClientRequests.size, 0);
  assert.equal(input.listenerCount("data"), 0);
});
test("ordinary invalid ACP JSON still recovers for subsequent requests", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let frames = "";
  output.on("data", (chunk) => {
    frames += chunk;
  });
  const server = new AcpServer({ input, output });
  const run = server.run();
  input.write(
    'invalid\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n',
  );
  await new Promise((resolve) => setImmediate(resolve));
  input.end();
  await run;
  assert.match(frames, /-32700/);
  assert.match(frames, /protocolVersion/);
});

test("fragmented JSONL handles CRLF, multiple frames, and final unterminated frame", async () => {
  const stream = new PassThrough();
  const values = [];
  const errors = [];
  attachJsonlReader(
    stream,
    (value) => values.push(value),
    (error) => errors.push(error),
    16,
  );
  for (const piece of ['"é"\r', "\n{}\r\n", '"final"']) stream.write(piece);
  stream.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(values, ["é", {}, "final"]);
  assert.deepEqual(errors, []);
});

test("launcher exits on oversized input while parent keeps stdin open", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [new URL("../src/provider.mjs", import.meta.url).pathname, "run", "--protocol", "acp-v1"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CADENCR_PI_COMMAND: "/nonexistent/pi" },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("launcher did not exit with stdin open"));
    }, 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.stdin.write("x".repeat(16 * 1024 * 1024 + 1));
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(stderr, /frame exceeds/);
  assert.doesNotMatch(stderr, /could not start Pi/);
});
