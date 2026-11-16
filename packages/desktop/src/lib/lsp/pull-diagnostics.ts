import { type Diagnostic } from "@codemirror/lint";
import { LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import type { EditorView } from "@codemirror/view";
import type * as lsp from "vscode-languageserver-protocol";
import { toast } from "sonner";
import { z } from "zod";
import { setServerDiagnostics } from "./merged-diagnostics";

const position = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
const diagnostic = z.object({
  range: z.object({ start: position, end: position }),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  source: z.string().optional(),
  message: z.union([
    z.string(),
    z.object({ kind: z.enum(["plaintext", "markdown"]), value: z.string() }),
  ]),
});
const reportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("full"),
    resultId: z.string().optional(),
    items: z.array(diagnostic),
  }),
  z.object({ kind: z.literal("unchanged"), resultId: z.string() }),
]);
const refreshers = new WeakMap<LSPClient, Set<() => void>>();

export function refreshPullDiagnostics(client: LSPClient): void {
  for (const refresh of refreshers.get(client) ?? []) refresh();
}

/** One request per editor and server; stale replies never replace current diagnostics. */
export class PullDiagnostics {
  private request: lsp.DocumentDiagnosticParams | null = null;
  private resultId: string | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly client: LSPClient,
    private readonly view: EditorView,
    private readonly lspId: string,
    private readonly convert: (plugin: LSPPlugin, value: lsp.Diagnostic) => Diagnostic,
    private readonly refresh: () => void,
  ) {
    const subscribers = refreshers.get(client) ?? new Set<() => void>();
    subscribers.add(refresh);
    refreshers.set(client, subscribers);
  }

  invalidate(): void {
    this.generation++;
    if (this.request) this.client.cancelRequest(this.request);
    this.request = null;
  }

  async pull(): Promise<void> {
    if (this.disposed || !this.client.serverCapabilities?.diagnosticProvider) return;
    const file = this.client.workspace.files.find(
      (entry) => entry.getView(this.view) === this.view,
    );
    if (!file) return;
    this.invalidate();
    const generation = this.generation;
    const doc = this.view.state.doc;
    const params: lsp.DocumentDiagnosticParams = {
      textDocument: { uri: file.uri },
      previousResultId: this.resultId,
      identifier: this.client.serverCapabilities.diagnosticProvider.identifier,
    };
    this.request = params;
    try {
      const raw = await this.client.request<lsp.DocumentDiagnosticParams, unknown>(
        "textDocument/diagnostic",
        params,
      );
      if (this.disposed || this.generation !== generation || this.view.state.doc !== doc) return;
      const report = reportSchema.parse(raw);
      this.resultId = report.resultId;
      if (report.kind === "full") {
        const plugin = LSPPlugin.get(this.view);
        if (!plugin) return;
        const diagnostics = report.items.map((item) => this.convert(plugin, item));
        this.view.dispatch({
          effects: setServerDiagnostics.of({ lspId: this.lspId, diagnostics }),
        });
      }
    } catch (error: unknown) {
      if (this.disposed || this.generation !== generation) return;
      const cancellation = z
        .object({ code: z.union([z.literal(-32800), z.literal(-32801)]) })
        .safeParse(error);
      if (!cancellation.success) toast.error(`Could not refresh diagnostics from ${this.lspId}.`);
    } finally {
      if (this.request === params) this.request = null;
    }
  }

  destroy(): void {
    this.disposed = true;
    this.invalidate();
    refreshers.get(this.client)?.delete(this.refresh);
  }
}
