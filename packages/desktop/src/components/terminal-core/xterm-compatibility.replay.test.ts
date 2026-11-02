// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as Xterm } from "@xterm/xterm";
import { XtermCompatibility } from "./xterm-compatibility";
import { createTerminalTransportBridge } from "./terminal-transport-bridge";
import { DEFAULT_TERMINAL_PALETTE } from "./terminal-palette";

let term: Xterm;
let adapter: XtermCompatibility;
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

beforeEach(() => {
  // Exercise the real xterm parser and async write buffer without browser graphics.
  const open = vi.spyOn(Xterm.prototype, "open").mockImplementation(() => {});
  adapter = new XtermCompatibility(document.createElement("div"), {
    font: { family: "monospace", size: 13 },
    colors: DEFAULT_TERMINAL_PALETTE,
    cursor: { style: "block", blink: false },
    scrollback: 1000,
  });
  const instance = open.mock.contexts[0];
  if (!(instance instanceof Xterm)) throw new Error("Expected the adapter's real xterm instance");
  term = instance;
});
afterEach(() => {
  adapter.dispose();
  vi.restoreAllMocks();
});

async function flush() {
  await Promise.resolve(); // Drain any buffered transport output first.
  await new Promise<void>((resolve) => term.write("", resolve));
}

function connect() {
  const writes: string[] = [];
  const bridge = createTerminalTransportBridge({
    write: (bytes) => writes.push(decode(bytes)),
    resize: vi.fn(),
  });
  adapter.attach(bridge.transport);
  return { bridge, writes };
}

describe("compatibility replay with the real xterm parser", () => {
  it("renders snapshot history without answering its old cursor-position queries", async () => {
    const { bridge, writes } = connect();
    bridge.deliverSnapshot(encode("history\x1b[6n"));
    await flush();
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("history");
    expect(writes).toEqual([]);
  });

  it("answers live queries queued immediately after replay, in parse order", async () => {
    const { bridge, writes } = connect();
    bridge.deliverSnapshot(encode("history\x1b[6n"));
    bridge.deliverData(encode("\x1b[6n"));
    await flush();
    expect(writes).toEqual(["\x1b[1;8R"]);
  });

  it("keeps user input flowing while asynchronous replay is pending", async () => {
    const { bridge, writes } = connect();
    bridge.deliverSnapshot(encode("history\x1b[6n"));
    await Promise.resolve();
    term.input("é\x1b[A\x1b[1;8R", true);
    await flush();
    expect(writes).toEqual(["é\x1b[A\x1b[1;8R"]);
    term.input("after replay", true);
    expect(writes).toEqual(["é\x1b[A\x1b[1;8R", "after replay"]);
  });

  it("suppresses local-notice queries while retaining subsequent live replies", async () => {
    const { bridge, writes } = connect();
    adapter.write("notice\x1b[6n");
    bridge.deliverData(encode("\x1b[6n"));
    await flush();
    expect(writes).toEqual(["\x1b[1;7R"]);
  });

  it.each([
    "\x1b[5n",
    "\x1b[6n",
    "\x1b[?6n",
    "\x1b[c",
    "\x1b[>c",
    "\x1b[4$p",
    "\x1b[?7$p",
    "\x1bP$qm\x1b\\",
  ])("suppresses replayed status queries but answers the same live query: %j", async (query) => {
    const { bridge, writes } = connect();
    bridge.deliverSnapshot(encode(query));
    await flush();
    expect(writes).toEqual([]);
    bridge.deliverData(encode(query));
    await flush();
    expect(writes).toHaveLength(1);
  });

  it("keeps replay policy across every byte boundary and preserves split UTF-8", async () => {
    const { writes } = connect();
    const bytes = encode("é中\x1b[6n");
    for (let split = 0; split <= bytes.length; split++) {
      adapter.feed(encode("\x1bc"), { replyToQueries: false });
      adapter.feed(bytes.slice(0, split), { replyToQueries: false });
      adapter.feed(bytes.slice(split), { replyToQueries: false });
      await flush();
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("é中");
    }
    expect(writes).toEqual([]);
    adapter.feed(encode("\x1b[6n"));
    await flush();
    expect(writes).toEqual(["\x1b[1;4R"]);
  });

  it("preserves alternate-screen and SGR state from replay", async () => {
    const { bridge, writes } = connect();
    bridge.deliverSnapshot(encode("\x1b[?1049h\x1b[31mred\x1b[6n"));
    await flush();
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("red");
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
    expect(writes).toEqual([]);
  });
});
