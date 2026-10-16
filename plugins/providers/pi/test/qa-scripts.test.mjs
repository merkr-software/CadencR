import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { qaClient } from "../scripts/qa-client.mjs";
import { runResumeQa } from "../scripts/resume-qa.mjs";
import { runSmokeQa } from "../scripts/smoke-acp.mjs";

function childFixture() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("shared QA client denies even live-QA-safe requests by default", () => {
  const child = childFixture();
  let reply;
  child.stdin.on("data", (chunk) => {
    reply = JSON.parse(chunk.toString());
  });
  const client = qaClient(child);
  child.stdout.write(
    `${JSON.stringify({
      id: "permission",
      method: "session/request_permission",
      params: {
        toolCall: { toolName: "bash", rawInput: { command: "printf PI_RPC_TOOL_OK" } },
      },
    })}\n`,
  );
  assert.equal(reply.result.outcome.optionId, "reject_once");
  client.dispose();
});

for (const frame of ["invalid\n", "null\n", "[]\n"]) {
  test(`malformed output fails pending and future requests: ${frame.trim()}`, async () => {
    const child = childFixture();
    const client = qaClient(child);
    const checks = [
      assert.rejects(client.request("initialize", {}), /invalid/),
      assert.rejects(client.request("session/new", {}), /invalid/),
    ];
    child.stdout.write(frame);
    await Promise.all(checks);
    await assert.rejects(client.request("initialize", {}), /invalid/);
    client.dispose();
    assert.equal(child.stdout.listenerCount("data"), 0);
  });
}

test("request timeout removes its pending entry without poisoning later requests", async () => {
  const child = childFixture();
  const client = qaClient(child, { timeoutMs: 5 });
  await assert.rejects(client.request("initialize", {}), /timed out/);
  child.stdout.write('{"id":1,"result":{}}\n');
  const next = client.request("initialize", {}, 100);
  child.stdout.write('{"id":2,"result":{"ok":true}}\n');
  assert.deepEqual(await next, { ok: true });
  client.dispose();
});

function launcherFixture({ failInitialize = false } = {}) {
  const launches = [];
  const decisions = [];
  let codeword;
  const configOptions = [
    {
      id: "model",
      category: "model",
      currentValue: "fake/model",
      options: [{ value: "fake/model" }],
    },
  ];
  const spawnImpl = (command, args, options) => {
    const child = childFixture();
    const directory = args[args.indexOf("--session-dir") + 1];
    const evidence = join(directory, "retained.db");
    writeFileSync(evidence, "synthetic fixture");
    launches.push({ child, directory, evidence });
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const message = JSON.parse(chunk.toString());
        if (!message.method) {
          decisions.push(message.result.outcome.optionId);
          callback();
          return;
        }
        queueMicrotask(() => {
          if (failInitialize) {
            emit({ id: message.id, error: { message: "fixture initialize failure" } });
            return;
          }
          let result = {};
          if (message.method === "initialize")
            result = {
              protocolVersion: 1,
              agentCapabilities: { sessionCapabilities: { resume: {} } },
            };
          if (
            ["session/new", "session/resume", "session/set_config_option"].includes(message.method)
          )
            result = { sessionId: "fake", configOptions };
          if (message.method === "session/prompt") {
            codeword ??= message.params.prompt[0].text.match(/PI_RPC_RESUME_\d+/)[0];
            result = { stopReason: "end_turn" };
            emit({
              method: "session/update",
              params: {
                update: { sessionUpdate: "agent_message_chunk", content: { text: codeword } },
              },
            });
          }
          emit({
            id: "permission",
            method: "session/request_permission",
            params: {
              toolCall: { toolName: "bash", rawInput: { command: "printf PI_RPC_TOOL_OK" } },
            },
          });
          emit({ id: message.id, result });
        });
        callback();
      },
      final(callback) {
        child.exitCode = 0;
        child.emit("exit", 0);
        callback();
      },
    });
    child.kill = () => {
      throw new Error("expected graceful exit");
    };
    assert.ok(options.env);
    return child;
  };
  return { spawnImpl, launches, decisions, configOptions };
}

async function assertRetained(mock) {
  for (const { child, directory, evidence } of mock.launches) {
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal(await readFile(evidence, "utf8"), "synthetic fixture");
    assert.equal(child.exitCode, 0);
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
  }
  assert.ok(mock.decisions.every((decision) => decision === "reject_once"));
}

test("resume QA denies permissions, confirms both exits and retains session evidence", async () => {
  const mock = launcherFixture();
  await runResumeQa({ env: { CADENCR_PI_LIVE_QA: "1" }, spawnImpl: mock.spawnImpl });
  assert.equal(mock.launches.length, 2);
  assert.ok(mock.decisions.length > 0);
  await assertRetained(mock);
});

for (const kind of ["smoke", "resume"]) {
  test(`${kind} QA cleans up child after early request failure but retains scratch`, async () => {
    const mock = launcherFixture({ failInitialize: true });
    const options = {
      env: { CADENCR_PI_LIVE_QA: "1" },
      spawnImpl: mock.spawnImpl,
      execFileImpl: async () => ({ stdout: JSON.stringify(mock.configOptions) }),
    };
    await assert.rejects(
      kind === "smoke" ? runSmokeQa(options) : runResumeQa(options),
      /fixture initialize failure/,
    );
    await assertRetained(mock);
  });
}

test("smoke QA prints and retains its scratch path even when discovery fails", async (t) => {
  let printed = "";
  t.mock.method(process.stderr, "write", (text) => {
    printed += text;
    return true;
  });
  await assert.rejects(
    runSmokeQa({
      execFileImpl: async () => {
        throw new Error("fixture discovery failure");
      },
      spawnImpl: () => {
        throw new Error("must not launch");
      },
    }),
    /fixture discovery failure/,
  );
  const directory = printed.match(/retained at (.+)\n/)[1];
  assert.equal((await stat(directory)).isDirectory(), true);
});

test("spawn failure is preserved without waiting or signalling a nonexistent child", async () => {
  const child = childFixture();
  child.kill = () => {
    throw new Error("must not signal failed spawn");
  };
  const client = qaClient(child);
  const pending = assert.rejects(client.request("initialize", {}), /fixture ENOENT/);
  child.emit("error", new Error("fixture ENOENT"));
  await pending;
  const { stopChild } = await import("../scripts/qa-client.mjs");
  await stopChild(child);
  client.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.listenerCount("error"), 0);
});

test("dispose safely handles a queued stdin error until its close event", async () => {
  const child = childFixture();
  const client = qaClient(child);
  client.dispose();
  child.stdin.emit("error", new Error("fixture late stdin failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.stdin.listenerCount("error"), 0);
  assert.equal(child.stdin.listenerCount("close"), 0);
});
