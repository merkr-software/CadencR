// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { LSPClient, type Transport } from "@codemirror/lsp-client";
import { diagnosticCount } from "@codemirror/lint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { cadencrServerDiagnostics, type ClientRef } from "./diagnostics";
import { mergedDiagnostics, mergedDiagnosticsField } from "./merged-diagnostics";
import { CadencrWorkspace } from "./cadencr-workspace";
import { refreshPullDiagnostics } from "./pull-diagnostics";

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

function initializeClient(
  client: LSPClient,
  transport: FakeTransport,
  pull = false,
): Promise<null> {
  client.connect(transport);
  transport.emit(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: {
          textDocumentSync: { openClose: true, change: 2 },
          ...(pull
            ? {
                diagnosticProvider: {
                  identifier: "lint",
                  interFileDependencies: false,
                  workspaceDiagnostics: false,
                },
              }
            : {}),
        },
      },
    }),
  );
  return client.initializing;
}

function pullRequest(transport: FakeTransport) {
  const schema = z.object({
    id: z.number(),
    method: z.literal("textDocument/diagnostic"),
    params: z.object({
      textDocument: z.object({ uri: z.string() }),
      previousResultId: z.string().optional(),
      identifier: z.string().optional(),
    }),
  });
  for (const message of transport.sent.toReversed()) {
    const parsed = schema.safeParse(JSON.parse(message));
    if (parsed.success) return parsed.data;
  }
  throw new Error("No diagnostic pull request was sent");
}

const pulledDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  severity: 1,
  message: "unused variable",
  source: "eslint",
};

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

  it("pulls diagnostics on open and after edits, preserving unchanged reports", async () => {
    vi.useFakeTimers();
    const uri = "file:///workspace/example.js";
    const transport = new FakeTransport();
    const ref: ClientRef = { current: null };
    const client = new LSPClient({ extensions: [cadencrServerDiagnostics("eslint", ref)] });
    ref.current = client;
    await initializeClient(client, transport, true);
    const view = new EditorView({
      doc: "const unused = 1;\n",
      extensions: [mergedDiagnostics(), client.plugin(uri, "javascript")],
    });
    await vi.advanceTimersByTimeAsync(1);
    const first = pullRequest(transport);
    expect(first.params.textDocument.uri).toBe(uri);
    expect(first.params.identifier).toBe("lint");
    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: first.id,
        result: { kind: "full", resultId: "one", items: [pulledDiagnostic] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticCount(view.state)).toBe(1);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n" } });
    await vi.advanceTimersByTimeAsync(501);
    const second = pullRequest(transport);
    expect(second.params.previousResultId).toBe("one");
    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: second.id,
        result: { kind: "unchanged", resultId: "two" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticCount(view.state)).toBe(1);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "console.log(1);\n" } });
    await vi.advanceTimersByTimeAsync(501);
    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pullRequest(transport).id,
        result: { kind: "full", resultId: "three", items: [] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticCount(view.state)).toBe(0);
    view.destroy();
    client.disconnect();
  });

  it("cancels stale pulls and ignores replies after edits or editor disposal", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const ref: ClientRef = { current: null };
    const client = new LSPClient({ extensions: [cadencrServerDiagnostics("eslint", ref)] });
    ref.current = client;
    await initializeClient(client, transport, true);
    const view = new EditorView({
      doc: "const unused = 1;\n",
      extensions: [
        mergedDiagnostics(),
        client.plugin("file:///workspace/example.js", "javascript"),
      ],
    });
    await vi.advanceTimersByTimeAsync(1);
    const first = pullRequest(transport);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "console.log(1);\n" } });
    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: first.id,
        result: { kind: "full", items: [pulledDiagnostic] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticCount(view.state)).toBe(0);
    expect(transport.sent.some((message) => message.includes("$/cancelRequest"))).toBe(true);
    await vi.advanceTimersByTimeAsync(501);
    const second = pullRequest(transport);
    view.destroy();
    transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: second.id,
        result: { kind: "full", items: [pulledDiagnostic] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();
  });

  it("keeps a secondary linter synchronized and merges its pulls with primary diagnostics", async () => {
    vi.useFakeTimers();
    const uri = "file:///workspace/example.js";
    const clients = await Promise.all(
      ["typescript", "eslint"].map(async (id) => {
        const transport = new FakeTransport();
        const ref: ClientRef = { current: null };
        const client = new LSPClient({
          workspace: (owner) => new CadencrWorkspace(owner),
          extensions: [cadencrServerDiagnostics(id, ref)],
        });
        ref.current = client;
        await initializeClient(client, transport, id === "eslint");
        const workspace = client.workspace;
        if (!(workspace instanceof CadencrWorkspace)) throw new Error("Expected app workspace");
        return { client, workspace, transport };
      }),
    );
    const primary = clients[0];
    const secondary = clients[1];
    const view = new EditorView({
      doc: "const unused = 1;\n",
      extensions: [
        mergedDiagnostics(),
        ...clients.map(({ workspace }) => workspace.editorPlugin(uri, "javascript")),
      ],
    });
    await vi.advanceTimersByTimeAsync(1);
    for (const { transport } of clients) {
      expect(
        transport.sent.filter((message) => message.includes('"method":"textDocument/didOpen"')),
      ).toHaveLength(1);
    }
    primary.transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          diagnostics: [
            {
              ...pulledDiagnostic,
              source: "typescript",
              message: "type error",
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
            },
          ],
        },
      }),
    );
    secondary.transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pullRequest(secondary.transport).id,
        result: { kind: "full", items: [pulledDiagnostic] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect([...view.state.field(mergedDiagnosticsField).keys()]).toEqual(["typescript", "eslint"]);
    expect(diagnosticCount(view.state)).toBe(2);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "console.log(1);\n" } });
    await vi.advanceTimersByTimeAsync(501);
    for (const { transport } of clients) {
      const changes = transport.sent.filter((message) =>
        message.includes('"method":"textDocument/didChange"'),
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]).toContain("console.log(1);");
    }
    secondary.transport.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: pullRequest(secondary.transport).id,
        result: { kind: "full", items: [] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnosticCount(view.state)).toBe(1);
    const previousPull = pullRequest(secondary.transport).id;
    refreshPullDiagnostics(secondary.client);
    await vi.advanceTimersByTimeAsync(1);
    expect(pullRequest(secondary.transport).id).toBeGreaterThan(previousPull);
    view.destroy();
    await vi.advanceTimersByTimeAsync(0);
    for (const { client, workspace, transport } of clients) {
      expect(workspace.files).toHaveLength(0);
      expect(
        transport.sent.filter((message) => message.includes('"method":"textDocument/didClose"')),
      ).toHaveLength(1);
      client.disconnect();
    }
  });
});
