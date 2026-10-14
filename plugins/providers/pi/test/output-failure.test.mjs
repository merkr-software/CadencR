import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { AcpServer } from "../src/acp-server.mjs";
import { JsonLineWriter } from "../src/jsonl.mjs";

for (const request of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
  { id: 1 },
  { jsonrpc: "2.0", id: 1, method: 3 },
]) {
  test(`output EPIPE drains native cleanup for ${request.method ?? "invalid request"}`, async () => {
    const input = new PassThrough();
    const failure = new Error("write EPIPE");
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    const server = new AcpServer({ input, output });
    let releaseCleanup;
    const cleanup = new Promise((resolve) => {
      releaseCleanup = resolve;
    });
    let closeCount = 0;
    server.sessions.set("active-native-child", {
      close() {
        closeCount += 1;
        return cleanup;
      },
    });
    let finished = false;
    const running = server.run().finally(() => {
      finished = true;
    });
    const checked = assert.rejects(running, /write EPIPE/);
    input.write(`${JSON.stringify(request)}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCount, 1);
    assert.equal(finished, false, "pipe failure must wait for native teardown");
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(output.listenerCount("error"), 1, "retain error guard during teardown");
    releaseCleanup();
    await checked;
    await server.close();
    assert.equal(closeCount, 1);
    assert.equal(output.listenerCount("error"), 0);
    assert.equal(server.sessions.size, 0);
  });
}

test("writer shutdown drains queued writes before removing its output error listener", async () => {
  let finishWrite;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      finishWrite = callback;
    },
  });
  const failures = [];
  const writer = new JsonLineWriter(output, (error) => failures.push(error));
  const write = writer.write({ value: 1 });
  const checked = assert.rejects(write, /write EPIPE/);
  await new Promise((resolve) => setImmediate(resolve));
  const closed = writer.close();
  assert.equal(output.listenerCount("error"), 1);
  finishWrite(new Error("write EPIPE"));
  await checked;
  await closed;
  assert.equal(failures.length, 1);
  assert.equal(output.listenerCount("error"), 0);
  await assert.rejects(writer.write({ value: 2 }), /output closed/);
});

test("unsolicited output error closes the input reader and active session", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AcpServer({ input, output });
  let closed = 0;
  server.sessions.set("fake", {
    close: async () => {
      closed += 1;
    },
  });
  const running = server.run();
  const checked = assert.rejects(running, /output disconnected/);
  output.emit("error", new Error("output disconnected"));
  await checked;
  assert.equal(closed, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.equal(output.listenerCount("error"), 0);
});

test("explicit server shutdown detaches input listeners and is idempotent", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AcpServer({ input, output });
  server.run();
  const closing = server.close();
  assert.equal(server.close(), closing);
  await closing;
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.equal(output.listenerCount("error"), 0);
});
