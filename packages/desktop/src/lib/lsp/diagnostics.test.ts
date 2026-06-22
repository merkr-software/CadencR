import { EditorView } from "@codemirror/view";
import { LSPClient, type Transport } from "@codemirror/lsp-client";
import { diagnosticCount } from "@codemirror/lint";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cadencrServerDiagnostics, type ClientRef } from "./diagnostics";
import { mergedDiagnostics } from "./merged-diagnostics";

class FakeTransport implements Transport {
  readonly sent: string[] = [];
  private readonly handlers = new Set<(value: string) => void>();

  send(message: string): void {
    this.sent.push(message);
  }

  subscribe(handler: (value: string) => void): void {
    this.handlers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.handlers.delete(handler);
  }

  emit(message: string): void {
    for (const handler of this.handlers) handler(message);
  }
}

function initializeClient(client: LSPClient, transport: FakeTransport): Promise<null> {
  client.connect(transport);
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { textDocumentSync: { openClose: true, change: 2 } } },
    }),
  );
  return client.initializing;
}

describe("cadencrServerDiagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies publishDiagnostics even when a server reports a mismatched version", async () => {
    const uri = "file:///workspace/config.yaml";
    const transport = new FakeTransport();
    const ref: ClientRef = { current: null };
    const client = new LSPClient({ extensions: [cadencrServerDiagnostics("yaml", ref)] });
    ref.current = client;
    await initializeClient(client, transport);
    const view = new EditorView({
      doc: "name: test\n",
      extensions: [mergedDiagnostics(), client.plugin(uri, "yaml")],
    });

    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          version: 99,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 4 },
              },
              severity: 1,
              message: "bad yaml",
            },
          ],
        },
      }),
    );

    expect(diagnosticCount(view.state)).toBe(1);
    view.destroy();
    client.disconnect();
  });

  it("syncs document changes so servers can publish live diagnostics", async () => {
    vi.useFakeTimers();
    const uri = "file:///workspace/config.yaml";
    const transport = new FakeTransport();
    const ref: ClientRef = { current: null };
    const client = new LSPClient({ extensions: [cadencrServerDiagnostics("yaml", ref)] });
    ref.current = client;
    await initializeClient(client, transport);
    const view = new EditorView({
      doc: "name: ok\n",
      extensions: [mergedDiagnostics(), client.plugin(uri, "yaml")],
    });
    await Promise.resolve();
    transport.sent.length = 0;

    view.dispatch({ changes: { from: 6, to: 8, insert: "[" } });
    await vi.advanceTimersByTimeAsync(501);

    const methods = transport.sent.map((message) => {
      const parsed = JSON.parse(message) as { method?: string };
      return parsed.method;
    });
    expect(methods).toContain("textDocument/didChange");
    view.destroy();
    client.disconnect();
  });
});
