import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import cadencrPermissions from "../src/cadencr-permissions.mjs";
import { attachJsonlReader } from "../src/jsonl.mjs";
import { discoverModels } from "../src/models-command.mjs";
import { runtimeArgs } from "../src/pi-args.mjs";
import { buildModelConfigOption, CONNECTOR_VERSION, parseInvocation } from "../src/provider.mjs";
import { buildSessionConfigOptions, supportedThinkingLevels } from "../src/pi-models.mjs";
import { PiRpcClient } from "../src/pi-rpc-client.mjs";
import { decodeSessionId, encodeSessionId } from "../src/session-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = resolve(root, "src/provider.mjs");
const fakePi = resolve(root, "test/fixtures/fake-pi-rpc");

test("parses the Cadencr executable contract", () => {
  assert.equal(CONNECTOR_VERSION, "0.4.0");
  assert.deepEqual(parseInvocation(["version"]), { command: "version" });
  assert.deepEqual(
    parseInvocation([
      "models",
      "--format",
      "acp-config-options-v1",
      "--cwd",
      "/tmp/project",
      "--offline",
    ]),
    { command: "models", cwd: "/tmp/project", piArgs: ["--offline"] },
  );
  assert.deepEqual(parseInvocation(["run", "--protocol", "acp-v1", "--offline"]), {
    command: "run",
    piArgs: ["--offline"],
  });
});

test("uses one connector-owned Pi argument policy for runtime and discovery", async () => {
  assert.throws(
    () => runtimeArgs(["--session=foreign"], "/connector/permissions.mjs"),
    /conflicts with the connector/,
  );
  let clientCreated = false;
  await assert.rejects(
    discoverModels({
      cwd: root,
      piArgs: ["--mode=print"],
      clientFactory() {
        clientCreated = true;
      },
    }),
    /conflicts with the connector/,
  );
  assert.equal(clientCreated, false);
});

test("binds durable ACP session IDs to a normalized workspace", () => {
  const sessionId = encodeSessionId(root, "native-pi-session");
  assert.deepEqual(decodeSessionId(sessionId), {
    cwd: root,
    nativeSessionId: "native-pi-session",
  });
  assert.throws(() => decodeSessionId("native-pi-session"), /not workspace-bound/);
  assert.throws(() => decodeSessionId(`${sessionId}=`), /invalid/);
});

test("builds rich model metadata from native Pi model objects", () => {
  const option = buildModelConfigOption(
    {
      models: [
        {
          provider: "anthropic",
          id: "sonnet",
          name: "Claude Sonnet",
          reasoning: false,
          contextWindow: 1000,
        },
        {
          provider: "openai",
          id: "gpt-5",
          name: "GPT-5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 2000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        },
      ],
    },
    { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "high" },
  );
  assert.equal(option.currentValue, "openai/gpt-5");
  assert.equal(option.options[1].description, "2,000 token context · vision");
  assert.deepEqual(option.options[1]._meta.cadencr.supportedEffortLevels, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(option.options[0]._meta, undefined);
});

test("matches Pi thinking-level capability rules", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } }),
    ["off", "minimal", "low", "medium", "high", "max"],
  );
});

test("rejects malformed, empty, trimmed, and duplicate Pi model output", () => {
  assert.throws(() => buildModelConfigOption({ models: [] }, {}), /no available models/);
  assert.throws(() => buildModelConfigOption({ models: [null] }, {}), /malformed model entry/);
  assert.throws(
    () => buildModelConfigOption({ models: [{ provider: "fake", id: " bad " }] }, {}),
    /invalid model ID/,
  );
  assert.throws(
    () =>
      buildModelConfigOption(
        {
          models: [
            { provider: "fake", id: "same" },
            { provider: "fake", id: "same" },
          ],
        },
        {},
      ),
    /duplicate model ID/,
  );
});

test("builds the complete live Pi session config snapshot", () => {
  const options = buildSessionConfigOptions({
    availableModels: { models: [{ provider: "fake", id: "m", reasoning: true }] },
    state: {
      model: { provider: "fake", id: "m", reasoning: true },
      thinkingLevel: "high",
      autoCompactionEnabled: true,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
    },
    thinkingLevels: ["off", "low", "high"],
  });
  assert.deepEqual(
    options.map((option) => option.id),
    ["model", "thinking_level", "auto_compaction", "steering_mode", "follow_up_mode"],
  );
  assert.equal(options[1].category, "thought_level");
  assert.equal(options[4].currentValue, "one-at-a-time");
});

test("strict JSONL framing preserves Unicode line separators", async () => {
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const messages = [];
  attachJsonlReader(stream, (message) => messages.push(message), assert.fail);
  stream.end('{"text":"a\u2028b\u2029c"}\n');
  await once(stream, "end");
  assert.deepEqual(messages, [{ text: "a b c" }]);
});

test("Pi RPC close waits for termination and kills a stuck child", async () => {
  const client = new PiRpcClient({
    command: process.execPath,
    args: [
      "-e",
      `process.on("SIGTERM", () => {}); process.stdout.write('{"type":"ready"}\\n'); setInterval(() => {}, 1000);`,
    ],
    cwd: root,
  });
  client.on("fatal", () => {});
  client.start();
  await once(client, "event");
  const startedAt = Date.now();
  await client.close();
  assert(Date.now() - startedAt < 2_500, "stuck Pi child was not reaped within the bound");
});

test("Pi RPC surfaces stdin EPIPE without crashing and rejects pending requests", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  const client = new PiRpcClient({ command: "fake", args: [], cwd: root, spawnImpl: () => child });
  const fatal = once(client, "fatal");
  client.start();
  const pending = client.request("get_state");
  const rejected = assert.rejects(pending, /Pi RPC input failed: write EPIPE.*native diagnostic/);
  child.stderr.write("native diagnostic");
  child.stdin.emit("error", new Error("write EPIPE"));
  assert.match((await fatal)[0].message, /Pi RPC input failed: write EPIPE/);
  await rejected;
  await client.close();
  assert.equal(child.signalCode, "SIGTERM");
  // Late pipe errors after cleanup are still handled, rather than process-fatal.
  child.stdin.emit("error", new Error("late EPIPE"));
});

test("permission extension prompts only for mutating tools", async () => {
  let handler;
  cadencrPermissions({
    on(_event, callback) {
      handler = callback;
    },
  });
  let confirms = 0;
  const context = {
    hasUI: true,
    mode: "rpc",
    signal: undefined,
    ui: {
      async confirm() {
        confirms += 1;
        return false;
      },
    },
  };
  assert.equal(
    await handler({ toolName: "read", toolCallId: "r", input: { path: "x" } }, context),
    undefined,
  );
  const blocked = await handler(
    { toolName: "write", toolCallId: "w", input: { path: "x", content: "y" } },
    context,
  );
  assert.equal(confirms, 1);
  assert.equal(blocked.block, true);
});

test("native Pi RPC bridge supports discovery, config, streaming, tools, permissions, and cancel", async () => {
  await chmod(fakePi, 0o755);
  const child = spawn(process.execPath, [provider, "run", "--protocol", "acp-v1"], {
    cwd: root,
    env: { ...process.env, CADENCR_PI_COMMAND: fakePi },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = protocolClient(child);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentCapabilities.promptCapabilities.image, true);
    assert.deepEqual(initialized.agentCapabilities.sessionCapabilities, {
      resume: {},
      close: {},
    });

    const session = await client.request("session/new", { cwd: root, mcpServers: [] });
    assert.equal(session.configOptions.length, 5);
    assert.equal(session.configOptions[0].currentValue, "fake/small");
    const configured = await client.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value: "fake/reasoning",
    });
    assert.equal(configured.configOptions[0].currentValue, "fake/reasoning");
    assert.equal(configured.configOptions[1].currentValue, "medium");

    const simple = client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    assert.equal((await simple).stopReason, "end_turn");
    assert(
      client.notifications.some(
        (message) => message.params?.update?.sessionUpdate === "agent_message_chunk",
      ),
    );
    assert(
      client.notifications.some(
        (message) => message.params?.update?.sessionUpdate === "usage_update",
      ),
    );

    client.onServerRequest = (message) => {
      assert.equal(message.method, "session/request_permission");
      assert.equal(message.params.toolCall.toolName, "write");
      assert.deepEqual(
        message.params.options.map((option) => option.optionId),
        ["allow_once", "reject_once"],
      );
      client.respond(message.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
    };
    const tool = await client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "use tool" }],
    });
    assert.equal(tool.stopReason, "end_turn");
    assert(
      client.notifications.some((message) => message.params?.update?.sessionUpdate === "tool_call"),
    );
    assert(client.notifications.some((message) => message.params?.update?.status === "completed"));

    const hanging = client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hang" }],
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    client.notify("session/cancel", { sessionId: session.sessionId });
    assert.equal((await hanging).stopReason, "cancelled");
    await client.request("session/close", { sessionId: session.sessionId });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)),
    ]);
  }
  assert.equal(stderr, "");
});

test("native Pi RPC sessions support stable resume and legacy load across restarts", async (t) => {
  await chmod(fakePi, 0o755);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cadencr-resume-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    CADENCR_PI_COMMAND: fakePi,
    FAKE_PI_STATE_FILE: join(temporaryDirectory, "session.json"),
  };

  const first = spawnProvider(env);
  const initialized = await first.client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  assert.equal(initialized.agentCapabilities.loadSession, true);
  assert.deepEqual(initialized.agentCapabilities.sessionCapabilities, {
    resume: {},
    close: {},
  });
  const created = await first.client.request("session/new", { cwd: root, mcpServers: [] });
  await first.client.request("session/set_config_option", {
    sessionId: created.sessionId,
    configId: "model",
    value: "fake/reasoning",
  });
  await first.client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "remember durable-memory" }],
  });
  await first.client.request("session/close", { sessionId: created.sessionId });
  await assert.rejects(
    first.client.request("session/load", {
      sessionId: created.sessionId,
      cwd: resolve(root, ".."),
      mcpServers: [],
    }),
    /belongs to .* not requested workspace/,
  );
  await stopProvider(first.child);

  const resumed = spawnProvider(env);
  try {
    await resumed.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const loaded = await resumed.client.request("session/resume", {
      sessionId: created.sessionId,
      cwd: root,
      mcpServers: [],
    });
    assert.equal(loaded.sessionId, undefined);
    assert.equal(loaded.configOptions[0].currentValue, "fake/reasoning");
    const notificationStart = resumed.client.notifications.length;
    await resumed.client.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "recall the saved value" }],
    });
    const promptNotifications = resumed.client.notifications.slice(notificationStart);
    assert(
      promptNotifications.some(
        (message) =>
          message.params?.update?.sessionUpdate === "agent_message_chunk" &&
          message.params.update.content?.text === "durable-memory",
      ),
    );
    await assert.rejects(
      resumed.client.request("session/resume", {
        sessionId: encodeSessionId(root, "missing-session"),
        cwd: root,
        mcpServers: [],
      }),
      // A fast native startup exit can close stdin before stderr is delivered.
      // Both failures must be surfaced as ACP errors, without killing the provider.
      /No session found matching 'missing-session'|Pi RPC input failed: write EPIPE|could not write Pi get_.* request: write EPIPE/,
    );
    await resumed.client.request("session/close", { sessionId: created.sessionId });
  } finally {
    await stopProvider(resumed.child);
  }
});

test("session/close cancels active work before releasing Pi", async () => {
  await chmod(fakePi, 0o755);
  const running = spawnProvider({ ...process.env, CADENCR_PI_COMMAND: fakePi });
  try {
    await running.client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const session = await running.client.request("session/new", { cwd: root, mcpServers: [] });
    const prompt = running.client.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hang" }],
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.deepEqual(
      await running.client.request("session/close", {
        sessionId: session.sessionId,
      }),
      {},
    );
    assert.equal((await prompt).stopReason, "cancelled");
    await assert.rejects(
      running.client.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "after close" }],
      }),
      /unknown Pi session/,
    );
  } finally {
    await stopProvider(running.child);
  }
});

test("closing ACP input drains an unanswered permission request", async () => {
  await chmod(fakePi, 0o755);
  const running = spawnProvider({ ...process.env, CADENCR_PI_COMMAND: fakePi });
  await running.client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  const session = await running.client.request("session/new", { cwd: root, mcpServers: [] });
  let permissionSeen;
  const sawPermission = new Promise((resolvePromise) => {
    permissionSeen = resolvePromise;
  });
  running.client.onServerRequest = permissionSeen;
  const prompt = running.client.request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "use tool" }],
  });
  void prompt.catch(() => {});
  await sawPermission;
  running.child.stdin.end();
  await Promise.race([
    once(running.child, "exit"),
    new Promise((_, rejectPromise) =>
      setTimeout(() => rejectPromise(new Error("connector did not close promptly")), 2_000),
    ),
  ]);
  await assert.rejects(prompt, /ACP input closed|Pi session closed|provider exited/);
});

function spawnProvider(env) {
  const child = spawn(process.execPath, [provider, "run", "--protocol", "acp-v1"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, client: protocolClient(child) };
}

async function stopProvider(child) {
  child.stdin.end();
  const exited = await Promise.race([
    once(child, "exit"),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 1000)),
  ]);
  if (exited !== null || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

function protocolClient(child) {
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
  });
  const pending = new Map();
  const notifications = [];
  const client = {
    notifications,
    onServerRequest: null,
    request(method, params) {
      const requestId = ++id;
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`${method} timed out`)), 5000);
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    respond(requestId, result) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`);
    },
  };
  attachJsonlReader(
    child.stdout,
    (message) => {
      if (message.method && message.id !== undefined) {
        client.onServerRequest?.(message);
        return;
      }
      if (message.method) {
        notifications.push(message);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    },
    (error) => {
      rejectPending(error);
    },
  );
  // close follows stdout/stderr drainage; exit may precede the final ACP reply.
  child.once("close", (code, signal) =>
    rejectPending(new Error(`provider exited (${signal ?? code}): ${stderr}`)),
  );

  function rejectPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  return client;
}
