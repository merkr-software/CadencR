import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSession } from "./lsp-session";

const { transport, handlers } = vi.hoisted(() => {
  const handlers = new Set<(message: string) => void>();
  return {
    handlers,
    transport: {
      send: vi.fn(),
      close: vi.fn(),
      subscribe: (handler: (message: string) => void) => handlers.add(handler),
      unsubscribe: (handler: (message: string) => void) => handlers.delete(handler),
    },
  };
});

vi.mock("@/api/generated", () => ({
  openSession: vi.fn(async () => ({
    session_id: "session-qa",
    initialization_options: { typescript: { tsdk: "/runtime/typescript/lib" } },
  })),
}));
vi.mock("./transport", () => ({ connectLspWs: vi.fn(async () => transport) }));

function respond(response: object): void {
  for (const handler of handlers) handler(JSON.stringify({ jsonrpc: "2.0", id: 1, ...response }));
}

describe("buildSession handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  afterEach(() => vi.useRealTimers());

  it("keeps the session pending until the server accepts initialize", async () => {
    let ready = false;
    const pending = buildSession("/workspace", "typescript").then((session) => {
      ready = true;
      return session;
    });
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalled());
    expect(ready).toBe(false);
    expect(JSON.parse(transport.send.mock.calls[0][0])).toMatchObject({
      method: "initialize",
      params: {
        rootUri: "file:///workspace",
        initializationOptions: { typescript: { tsdk: "/runtime/typescript/lib" } },
      },
    });

    respond({ result: { capabilities: { textDocumentSync: 2 } } });
    const session = await pending;
    expect(ready).toBe(true);
    expect(session.client.serverCapabilities).toEqual({ textDocumentSync: 2 });
    expect(transport.send.mock.calls.map(([message]) => JSON.parse(message).method)).toEqual([
      "initialize",
      "initialized",
    ]);
    expect(transport.close).not.toHaveBeenCalled();
    session.client.disconnect();
  });

  it("surfaces an initialize rejection and releases the transport", async () => {
    const pending = buildSession("/workspace", "astro");
    const rejected = expect(pending).rejects.toThrow("The typescript.tsdk init option is required");
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalled());
    respond({ error: { code: -32603, message: "The typescript.tsdk init option is required" } });
    await rejected;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("fails and releases the transport when the server never initializes", async () => {
    vi.useFakeTimers();
    const pending = buildSession("/workspace", "typescript");
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(3_001);
    await rejected;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(handlers.size).toBe(0);
  });
});
