import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AcpServer } from "../src/acp-server.mjs";
import { PiAcpSession } from "../src/acp-session.mjs";
import { encodeSessionId } from "../src/session-identity.mjs";

for (const method of ["session/new", "session/resume", "session/load"]) {
  test(`EOF drains delayed ${method} creation without registering a late session`, async (t) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = [];
    output.on("data", (chunk) => replies.push(JSON.parse(chunk.toString())));
    const server = new AcpServer({ input, output });
    let finishCreation;
    let creationStarted;
    let finishCleanup;
    const started = new Promise((resolve) => {
      creationStarted = resolve;
    });
    const created = new Promise((resolve) => {
      finishCreation = resolve;
    });
    const cleaned = new Promise((resolve) => {
      finishCleanup = resolve;
    });
    let closeCount = 0;
    let announced = false;
    t.mock.method(PiAcpSession, "create", async () => {
      creationStarted();
      return created;
    });
    let runFinished = false;
    const running = server.run().then((result) => {
      runFinished = true;
      return result;
    });
    const sessionId = encodeSessionId(process.cwd(), "delayed-native-session");
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { cwd: process.cwd(), sessionId, mcpServers: [] },
      })}\n`,
    );
    await started;
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.closing, true);
    assert.equal(runFinished, false, "run must wait for in-flight creation");
    finishCreation({
      sessionId,
      async close() {
        closeCount += 1;
        await cleaned;
      },
      configOptions() {
        throw new Error("late session must not be registered");
      },
      announce() {
        announced = true;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCount, 1);
    assert.equal(runFinished, false, "run must wait for late native cleanup");
    finishCleanup();
    assert.equal(await running, 0);
    assert.equal(server.sessions.size, 0);
    assert.equal(server.pendingSessionOperations.size, 0);
    assert.equal(announced, false);
    assert.match(replies[0].error.message, /closed during session startup/);
    await server.close();
    assert.equal(closeCount, 1, "idempotent shutdown must not close twice");
  });
}

for (const method of ["session/new", "session/resume", "session/load"]) {
  test(`EOF preserves failed delayed ${method} cleanup despite the RPC error reply`, async (t) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = [];
    output.on("data", (chunk) => replies.push(JSON.parse(chunk.toString())));
    const server = new AcpServer({ input, output });
    let finishCreation;
    let creationStarted;
    const started = new Promise((resolve) => {
      creationStarted = resolve;
    });
    const created = new Promise((resolve) => {
      finishCreation = resolve;
    });
    let closeCount = 0;
    const cleanupError = new Error("late cleanup failed");
    t.mock.method(PiAcpSession, "create", async () => {
      creationStarted();
      return created;
    });
    const running = server.run();
    const rejectsCleanup = (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.message, "Pi session cleanup failed");
      assert.deepEqual(error.errors, [cleanupError]);
      return true;
    };
    const rejected = assert.rejects(running, rejectsCleanup);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          cwd: process.cwd(),
          sessionId: encodeSessionId(process.cwd(), "late"),
          mcpServers: [],
        },
      })}\n`,
    );
    await started;
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    finishCreation({
      sessionId: encodeSessionId(process.cwd(), "late"),
      async close() {
        closeCount += 1;
        throw cleanupError;
      },
    });
    await rejected;
    await assert.rejects(server.close(), rejectsCleanup);
    assert.equal(closeCount, 1);
    assert.equal(server.sessions.size, 0);
    assert.equal(server.pendingSessionOperations.size, 0);
    assert.equal(replies[0].error.message, "late cleanup failed");
  });
}

for (const fails of [false, true]) {
  test(`EOF drains explicit session close${fails ? " and preserves failure" : ""}`, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const server = new AcpServer({ input, output });
    let release;
    const cleanup = new Promise((resolve, reject) => {
      release = fails ? reject : resolve;
    });
    let closeCount = 0;
    server.sessions.set("fake", {
      sessionId: "fake",
      close() {
        closeCount += 1;
        return cleanup;
      },
    });
    let finished = false;
    const running = server.run().finally(() => {
      finished = true;
    });
    const cleanupError = new Error("explicit cleanup failed");
    const checked = fails
      ? assert.rejects(running, (error) => {
          assert.deepEqual(error.errors, [cleanupError]);
          return true;
        })
      : running;
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/close", params: { sessionId: "fake" } })}\n`,
    );
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.sessions.size, 0);
    assert.equal(closeCount, 1);
    assert.equal(finished, false);
    release(cleanupError);
    await checked;
    if (fails) await assert.rejects(server.close(), /cleanup failed/);
    else await server.close();
    assert.equal(closeCount, 1);
    assert.equal(server.pendingSessionOperations.size, 0);
    assert.equal(output.listenerCount("error"), 0);
    assert.equal(input.listenerCount("data"), 0);
  });
}

test("failed creation preserves its internal native cleanup failure during EOF", async (t) => {
  const { PiRpcClient } = await import("../src/pi-rpc-client.mjs");
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const server = new AcpServer({ input, output });
  let failStartup;
  const startup = new Promise((_, reject) => {
    failStartup = reject;
  });
  const startupError = new Error("startup failed");
  const cleanupError = new Error("native termination failed");
  let closeCount = 0;
  t.mock.method(PiRpcClient.prototype, "start", () => {});
  t.mock.method(PiRpcClient.prototype, "request", () => startup);
  t.mock.method(PiRpcClient.prototype, "close", async () => {
    closeCount += 1;
    throw cleanupError;
  });
  const running = server.run();
  const checked = assert.rejects(running, (error) => {
    assert.deepEqual(error.errors, [cleanupError]);
    return true;
  });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: process.cwd() } })}\n`,
  );
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  failStartup(startupError);
  await checked;
  await assert.rejects(server.close(), /cleanup failed/);
  assert.equal(closeCount, 1);
  assert.equal(server.pendingSessionOperations.size, 0);
  assert.equal(output.listenerCount("error"), 0);
});
