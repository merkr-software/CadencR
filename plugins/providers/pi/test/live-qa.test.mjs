import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { LIVE_QA_COMMAND, liveQaPermission, runLiveQa } from "../scripts/live-qa.mjs";
import { qaClient, stopChild } from "../scripts/qa-client.mjs";

test("live QA permits only the exact harmless bash input", () => {
  const tool = (command, extra = {}) => ({ toolName: "bash", rawInput: { command, ...extra } });
  assert.equal(liveQaPermission(tool(LIVE_QA_COMMAND)), "allow_once");
  assert.equal(liveQaPermission(tool(LIVE_QA_COMMAND, { timeout: 5 })), "allow_once");
  for (const value of [
    null,
    {},
    { toolName: "bash" },
    { toolName: "write", rawInput: { command: LIVE_QA_COMMAND } },
    { toolName: "custom", rawInput: { command: LIVE_QA_COMMAND } },
    { toolName: "bash", title: LIVE_QA_COMMAND },
    tool(`${LIVE_QA_COMMAND}; touch unsafe`),
    tool(` ${LIVE_QA_COMMAND}`),
    tool(`${LIVE_QA_COMMAND}\n`),
    tool("rm -rf /"),
    tool(LIVE_QA_COMMAND, { cwd: "/" }),
    tool(LIVE_QA_COMMAND, { timeout: 100 }),
    tool(LIVE_QA_COMMAND, { timeout: "5" }),
  ])
    assert.equal(liveQaPermission(value), "reject_once");
});

test("live QA opt-in precedes scratch creation or launcher execution", async () => {
  let launched = false;
  await assert.rejects(
    runLiveQa({
      env: {},
      spawnImpl: () => {
        launched = true;
      },
    }),
    /may incur model costs/,
  );
  assert.equal(launched, false);
});

function mockLauncher({
  text = "PI_RPC_TEXT_OK",
  output = "PI_RPC_TOOL_OK",
  completionId = "bash-1",
  omitOutput = false,
  synchronousExit = false,
  omitPermission = false,
  permissionId = "bash-1",
} = {}) {
  const requests = [];
  const decisions = [];
  let launch;
  let preservedFile;
  const configOptions = [
    {
      id: "model",
      category: "model",
      currentValue: "fake/model",
      options: [{ value: "fake/model" }],
    },
    { id: "thinking_level", currentValue: "low" },
  ];
  const spawnImpl = (command, args, options) => {
    launch = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    let turn = 0;
    const update = (body) => emit({ method: "session/update", params: { update: body } });
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const request = JSON.parse(chunk.toString());
        if (!request.method) {
          decisions.push([request.id, request.result.outcome.optionId]);
          callback();
          return;
        }
        requests.push(request);
        queueMicrotask(() => {
          let result = {};
          if (request.method === "session/new") result = { sessionId: "fake", configOptions };
          if (request.method === "session/set_config_option") result = { configOptions };
          if (request.method === "session/prompt") {
            turn++;
            for (const [id, toolCall] of [
              [
                "safe",
                {
                  toolCallId: permissionId,
                  toolName: "bash",
                  rawInput: { command: LIVE_QA_COMMAND },
                },
              ],
              ["unsafe", { toolName: "bash", rawInput: { command: "touch unsafe" } }],
              ["custom", { toolName: "custom", rawInput: {} }],
            ])
              if (!omitPermission || turn === 1)
                emit({ id, method: "session/request_permission", params: { toolCall } });
            for (const body of [
              { sessionUpdate: "available_commands_update" },
              { sessionUpdate: "config_option_update" },
              {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: turn === 1 ? text : "tool done" },
              },
              ...(turn === 2
                ? [
                    {
                      sessionUpdate: "tool_call",
                      toolCallId: "bash-1",
                      toolName: "bash",
                      rawInput: { command: LIVE_QA_COMMAND },
                    },
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: completionId,
                      status: "completed",
                      ...(omitOutput
                        ? {}
                        : { rawOutput: { content: [{ type: "text", text: output }] } }),
                    },
                  ]
                : []),
              { sessionUpdate: "usage_update", used: 1, size: 10 },
            ])
              update(body);
            result = { stopReason: "end_turn" };
          }
          emit({ id: request.id, result });
        });
        callback();
      },
      final(callback) {
        child.exitCode = 0;
        if (synchronousExit) child.emit("exit", 0);
        else setImmediate(() => child.emit("exit", 0));
        callback();
      },
    });
    child.kill = () => {
      throw new Error("mock should exit normally");
    };
    preservedFile = join(options.cwd, "preserved.db");
    writeFileSync(preservedFile, "synthetic fixture, not a Cadencr database");
    return child;
  };
  return {
    spawnImpl,
    requests,
    decisions,
    get launch() {
      return launch;
    },
    get preservedFile() {
      return preservedFile;
    },
  };
}

test("mocked live QA isolates cwd, enforces permissions, and retains scratch files", async () => {
  const mock = mockLauncher({ synchronousExit: true });
  const env = { CADENCR_PI_LIVE_QA: "1", SENTINEL_SECRET: "never-in-acp" };
  const started = performance.now();
  await runLiveQa({ env, spawnImpl: mock.spawnImpl });
  assert.ok(performance.now() - started < 1000, "normal teardown must not wait five seconds");
  const { launch, requests, decisions, preservedFile } = mock;
  assert.equal(launch.options.env, env);
  assert.equal(JSON.stringify(requests).includes(env.SENTINEL_SECRET), false);
  assert.equal(
    requests.some((request) => Object.hasOwn(request.params, "env")),
    false,
  );
  assert.equal(isAbsolute(launch.options.cwd), true);
  assert.match(launch.options.cwd, /pi-cadencr-live-qa-/);
  assert.notEqual(launch.options.cwd, new URL("../", import.meta.url).pathname);
  assert.equal(
    requests.find((request) => request.method === "session/new").params.cwd,
    launch.options.cwd,
  );
  const sessionDir = launch.args[launch.args.indexOf("--session-dir") + 1];
  assert.equal(sessionDir, join(launch.options.cwd, "sessions"));
  assert.equal((await stat(sessionDir)).isDirectory(), true);
  // Retained scratch is deliberately not cleaned up, even when it contains a DB.
  assert.equal(await readFile(preservedFile, "utf8"), "synthetic fixture, not a Cadencr database");
  assert.deepEqual(decisions, [
    ["safe", "allow_once"],
    ["unsafe", "reject_once"],
    ["custom", "reject_once"],
    ["safe", "allow_once"],
    ["unsafe", "reject_once"],
    ["custom", "reject_once"],
  ]);
});

for (const [name, options, error] of [
  ["incorrect text", { text: "wrong" }, /incorrect text/],
  ["absent tool output", { omitOutput: true }, /tool_call_update/],
  ["incorrect tool output", { output: "wrong" }, /tool_call_update/],
  ["unrelated completion", { completionId: "unrelated" }, /tool_call_update/],
  ["absent tool-turn permission", { omitPermission: true }, /tool_call_update/],
  ["unrelated permission", { permissionId: "unrelated" }, /tool_call_update/],
]) {
  test(`live QA rejects ${name}`, async () => {
    const mock = mockLauncher(options);
    await assert.rejects(
      runLiveQa({ env: { CADENCR_PI_LIVE_QA: "1" }, spawnImpl: mock.spawnImpl }),
      error,
    );
  });
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

for (const failure of ["spawn", "exit", "stdin"]) {
  test(`QA client rejects pending and subsequent requests immediately on ${failure} failure`, async () => {
    const child = fakeChild();
    const client = qaClient(child);
    const first = assert.rejects(client.request("initialize", {}), /fixture|exited/);
    const second = assert.rejects(client.request("session/new", {}), /fixture|exited/);
    if (failure === "spawn") child.emit("error", new Error("fixture spawn failure"));
    if (failure === "exit") child.emit("exit", 1);
    if (failure === "stdin") child.stdin.emit("error", new Error("fixture stdin failure"));
    await Promise.all([first, second]);
    await assert.rejects(client.request("session/prompt", {}), /fixture|exited/);
    client.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    for (const event of ["error", "exit"]) assert.equal(child.listenerCount(event), 0);
    assert.equal(child.stdin.listenerCount("error"), 0);
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stdout.listenerCount("end"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
  });
}

test("QA client rejects synchronous stdin write failures without leaving a timer", async () => {
  const child = fakeChild();
  child.stdin.write = () => {
    throw new Error("fixture write failure");
  };
  const client = qaClient(child);
  await assert.rejects(client.request("initialize", {}), /fixture write failure/);
  await assert.rejects(client.request("initialize", {}), /fixture write failure/);
  client.dispose();
});

test("shutdown waits for SIGKILL exit when the child ignores EOF and SIGTERM", async () => {
  const child = fakeChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL")
      setImmediate(() => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
      });
    return true;
  };
  await stopChild(child, { graceMs: 5, signalMs: 5 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(child.listenerCount("exit"), 0);
});

test("shutdown reports bounded failure when even SIGKILL does not reap the child", async () => {
  const child = fakeChild();
  child.kill = () => true;
  await assert.rejects(stopChild(child, { graceMs: 5, signalMs: 5 }), /did not exit after SIGKILL/);
  assert.equal(child.listenerCount("exit"), 0);
});

test("shutdown awaits graceful SIGTERM exit without unnecessary SIGKILL", async () => {
  const child = fakeChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
    return true;
  };
  await stopChild(child, { graceMs: 5, signalMs: 100 });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("exit"), 0);
});

test("QA client rejects asynchronous stdin write callback failures", async () => {
  const child = fakeChild();
  child.stdin.write = (frame, callback) => {
    queueMicrotask(() => callback(new Error("fixture callback failure")));
    return true;
  };
  const client = qaClient(child);
  await assert.rejects(client.request("initialize", {}), /fixture callback failure/);
  await assert.rejects(client.request("session/new", {}), /fixture callback failure/);
  client.dispose();
});
