import { describe, expect, it, vi } from "vitest";

const applyServerEdit = vi.fn(async () => ({ applied: true }));
vi.mock("./apply-edit-bridge", () => ({
  applyServerEdit: (...args: unknown[]) => applyServerEdit(...(args as [])),
}));

import { WebSocketLspTransport } from "./transport";

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = MockWebSocket.OPEN;
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }
}

function parseSent(ws: MockWebSocket): unknown {
  return JSON.parse(ws.sent[0] ?? "null") as unknown;
}

describe("WebSocketLspTransport", () => {
  it("answers workspace/configuration requests without forwarding them to CodeMirror", () => {
    const ws = new MockWebSocket();
    const transport = new WebSocketLspTransport(ws as unknown as WebSocket);
    const subscriber = vi.fn();
    transport.subscribe(subscriber);

    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "workspace/configuration",
          params: { items: [{ section: "yaml" }, { section: "http" }] },
        }),
      }),
    );

    expect(subscriber).not.toHaveBeenCalled();
    expect(parseSent(ws)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: [{}, {}],
    });
  });

  it("applies workspace/applyEdit asynchronously and replies with the outcome", async () => {
    applyServerEdit.mockClear();
    const ws = new MockWebSocket();
    const transport = new WebSocketLspTransport(ws as unknown as WebSocket);
    const subscriber = vi.fn();
    transport.subscribe(subscriber);

    const edit = { changes: { "file:///a.ts": [] } };
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "workspace/applyEdit",
          params: { edit },
        }),
      }),
    );

    // Apply runs on a microtask; flush it.
    await new Promise((r) => setTimeout(r, 0));
    expect(applyServerEdit).toHaveBeenCalledWith(edit);
    expect(subscriber).not.toHaveBeenCalled();
    expect(parseSent(ws)).toEqual({ jsonrpc: "2.0", id: 11, result: { applied: true } });
  });
});
