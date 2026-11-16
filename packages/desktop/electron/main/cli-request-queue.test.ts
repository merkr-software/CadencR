import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_REQUEST_FLAG } from "./cli-request";
import { CliRequestQueue, handleCliArgv } from "./cli-request-queue";

const argv = (request: unknown): string[] => [
  "/opt/Cadencr/cadencr",
  `${CLI_REQUEST_FLAG}=${JSON.stringify(request)}`,
];

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cadencr-cli-queue-")));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CliRequestQueue", () => {
  it("pings on every push and hands each request out once, in order", () => {
    const notify = vi.fn();
    const queue = new CliRequestQueue(notify);
    queue.push({ kind: "update" });
    queue.push({ kind: "error", message: "nope" });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(queue.drain().map((item) => item.kind)).toEqual(["update", "error"]);
    expect(queue.drain()).toEqual([]);
  });

  it("keeps only the newest requests when nobody drains", () => {
    const queue = new CliRequestQueue(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let index = 0; index < 40; index += 1) {
      queue.push({ kind: "error", message: String(index) });
    }
    const [notice, ...items] = queue.drain();
    expect(notice).toMatchObject({ kind: "error", message: expect.stringMatching(/8 oldest/) });
    expect(items).toHaveLength(32);
    expect(items[0]).toMatchObject({ message: "8" });
    expect(warn).toHaveBeenCalled();
    queue.push({ kind: "update" });
    expect(queue.drain()).toEqual([expect.objectContaining({ kind: "update" })]);
    warn.mockRestore();
  });
});

describe("handleCliArgv", () => {
  it("ignores a launch without a request", async () => {
    const queue = new CliRequestQueue(() => undefined);
    await expect(handleCliArgv(["/opt/Cadencr/cadencr"], queue)).resolves.toBe(false);
    expect(queue.drain()).toEqual([]);
  });

  it("only brings the app forward for focus", async () => {
    const queue = new CliRequestQueue(() => undefined);
    await expect(handleCliArgv(argv({ version: 1, action: "focus" }), queue)).resolves.toBe(true);
    expect(queue.drain()).toEqual([]);
  });

  it("queues an open with what the path is", async () => {
    const file = path.join(dir, "main.rs");
    fs.writeFileSync(file, "fn main() {}");
    const queue = new CliRequestQueue(() => undefined);
    await handleCliArgv(argv({ version: 1, action: "open", path: file, line: 3 }), queue);
    await handleCliArgv(argv({ version: 1, action: "open", path: dir }), queue);
    expect(queue.drain()).toMatchObject([
      { kind: "open", path: file, pathKind: "file", line: 3 },
      { kind: "open", path: dir, pathKind: "directory" },
    ]);
  });

  it("queues an add only for a folder", async () => {
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "");
    const queue = new CliRequestQueue(() => undefined);
    await handleCliArgv(argv({ version: 1, action: "add", path: dir }), queue);
    await handleCliArgv(argv({ version: 1, action: "add", path: file }), queue);
    expect(queue.drain()).toMatchObject([
      { kind: "add", path: dir },
      { kind: "error", message: `${file} is not a folder.` },
    ]);
  });

  it("reports a path that disappeared and a request it can't read", async () => {
    const queue = new CliRequestQueue(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const missing = path.join(dir, "gone");
    await handleCliArgv(argv({ version: 1, action: "open", path: missing }), queue);
    await handleCliArgv(argv({ version: 9, action: "open", path: missing }), queue);
    const items = queue.drain();
    expect(items.map((item) => item.kind)).toEqual(["error", "error"]);
    expect(items[0]).toMatchObject({ message: expect.stringContaining(missing) });
    warn.mockRestore();
  });

  it("hands an update to the renderer, which starts the check once it listens", async () => {
    const queue = new CliRequestQueue(() => undefined);
    await handleCliArgv(argv({ version: 1, action: "update" }), queue);
    expect(queue.drain()).toMatchObject([{ kind: "update" }]);
  });
});
