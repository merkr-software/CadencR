import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { frames, write, TypeScriptConnection } from "./framing.mjs";

test("framing preserves fragmented UTF-8 bodies and adjacent messages", () => {
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  write(output, { id: 1, result: "français" });
  write(output, { id: 2, result: "日本語" });
  const input = new PassThrough();
  const received = [];
  frames(input, (message) => received.push(message), (error) => { throw error; });
  for (const byte of Buffer.concat(chunks)) input.write(Buffer.from([byte]));
  assert.deepEqual(received, [{ id: 1, result: "français" }, { id: 2, result: "日本語" }]);
});

test("duplicate or excessive Content-Length is rejected before body parsing", () => {
  for (const header of ["Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
    "Content-Length: 999999999\r\n\r\n"]) {
    const stream = new PassThrough();
    const failures = [];
    frames(stream, () => assert.fail("invalid frame must not be delivered"), (error) => failures.push(error));
    stream.write(header);
    assert.equal(failures.length, 1);
  }
});

test("terminated partial frames and completed overlong headers fail explicitly", () => {
  const overlong = new PassThrough();
  const failures = [];
  frames(overlong, () => assert.fail("invalid message"), (error) => failures.push(error.message));
  overlong.write("X-Padding: " + "a".repeat(16384) + "\r\nContent-Length: 2\r\n\r\n{}");
  assert.equal(failures[0], "LSP header exceeds bound");
  const partial = new PassThrough();
  frames(partial, () => assert.fail("incomplete message"), (error) => failures.push(error.message));
  partial.end("Content-Length: 10\r\n\r\n{}");
  return new Promise((resolve) => partial.on("end", () => {
    assert.equal(failures[1], "LSP stream ended with a partial frame");
    resolve();
  }));
});

test("TypeScript event IDs cannot satisfy an outstanding request", async () => {
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const events = [];
  const connection = new TypeScriptConnection(child, (message) => events.push(message), (error) => { throw error; });
  const promise = connection.request("quickinfo", { file: "/fixture.vue", line: 1, offset: 5 });
  write(child.stdout, { type: "event", request_seq: 1, event: "requestCompleted" });
  write(child.stdout, { type: "response", request_seq: 1, command: "quickinfo", success: true,
    body: { displayString: "const value: string" } });
  assert.deepEqual(await promise, { displayString: "const value: string" });
  assert.equal(events.length, 1);
  connection.dispose();
});

for (const ending of ["EOF", "SIGTERM"]) {
  test(`adapter bounds shutdown when child ignores ${ending} and SIGTERM`, { timeout: 7000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cadencr-adapter-test-"));
    const adapter = join(directory, "adapter");
    await mkdir(adapter);
    for (const file of ["adapter.mjs", "framing.mjs"]) {
      await copyFile(fileURLToPath(new URL(file, import.meta.url)), join(adapter, file));
    }
    await writeFile(join(adapter, "config.json"), JSON.stringify({ entry: "child.mjs", args: [] }));
    await writeFile(join(directory, "child.mjs"), `
      process.on("SIGTERM", () => {});
      process.stdin.resume();
      const body = JSON.stringify({ jsonrpc: "2.0", method: "test/ready", params: { pid: process.pid } });
      process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [join(adapter, "adapter.mjs")], {
      env: { HOME: directory, PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    let descendant;
    try {
      await new Promise((resolve, reject) => {
        frames(child.stdout, (message) => { descendant = message.params.pid; resolve(); }, reject);
        child.on("error", reject);
      });
      if (ending === "EOF") child.stdin.end();
      else child.kill("SIGTERM");
      assert.equal(await closed, 1);
      assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    } finally {
      child.kill("SIGKILL");
      if (descendant) {
        try { process.kill(descendant, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  });
}


test("packaged framing and adapters exactly match their shared sources", async () => {
  const plugins = new URL("../../plugins/lsp/", import.meta.url);
  const source = await readFile(new URL("framing.mjs", import.meta.url));
  const adapter = await readFile(new URL("adapter.mjs", import.meta.url));
  let copies = 0;
  for (const entry of await readdir(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = new URL(entry.name + "/", plugins);
    for (const subfolder of ["adapter", "bridge"]) {
      const path = new URL(subfolder + "/framing.mjs", folder);
      try { assert.deepEqual(await readFile(path), source, path.pathname); copies++; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    try {
      const path = new URL("adapter/adapter.mjs", folder);
      assert.deepEqual(await readFile(path), adapter, path.pathname);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  assert.equal(copies, 7);
});

test("slow outputs pause framed input and resume without accumulating all messages", async () => {
  const body = Buffer.from(JSON.stringify({ result: "x".repeat(64 * 1024) }));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  let produced = 0;
  const input = Readable.from((function* () {
    for (; produced < 1024; produced++) yield frame;
  })(), { highWaterMark: 1 });
  let received = 0;
  let maximum = 0;
  const output = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) {
    maximum = Math.max(maximum, this.writableLength);
    setImmediate(callback);
  } });
  await new Promise((resolve, reject) => {
    frames(input, (message) => { received++; return write(output, message); }, reject);
    input.on("end", resolve);
  });
  output.end();
  assert.equal(received, 1024);
  assert.ok(maximum < 128 * 1024, `output buffered ${maximum} bytes`);
  assert.ok(input.readableLength <= 1);
});

test("unawaited TypeScript notifications have a bounded backlog and propagate drain errors", async () => {
  const callbacks = [];
  const stdin = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) { callbacks.push(callback); } });
  const failures = [];
  const connection = new TypeScriptConnection({ stdin, stdout: new PassThrough() }, () => {}, (error) => failures.push(error));
  let written = 0;
  assert.throws(() => {
    for (; written < 1024; written++) connection.notify("change", { text: "x".repeat(64 * 1024) });
  }, /backlog exceeds bound/);
  assert.ok(written < 256);
  assert.ok(stdin.writableLength < 128 * 1024);
  const flushed = connection.flush();
  callbacks[0](new Error("broken output"));
  await assert.rejects(flushed, /broken output/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, "broken output");
  connection.dispose();
});

test("framed forwarding surfaces output errors and stops consuming input", async () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    setImmediate(() => callback(new Error("forwarding failed")));
  } });
  const failure = new Promise((resolve) => frames(input, (message) => write(output, message), resolve));
  write(input, { result: "first" });
  assert.equal((await failure).message, "forwarding failed");
  assert.equal(input.isPaused(), true);
  input.destroy();
});
