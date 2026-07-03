import { type Diagnostic } from "@codemirror/lint";
import { LSPPlugin, type LSPClient, type LSPClientExtension } from "@codemirror/lsp-client";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type * as lsp from "vscode-languageserver-protocol";
import { setServerDiagnostics } from "./merged-diagnostics";

function toSeverity(severity: lsp.DiagnosticSeverity | undefined): Diagnostic["severity"] {
  switch (severity) {
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

function messageToString(message: lsp.Diagnostic["message"]): string {
  return typeof message === "string" ? message : message.value;
}

function clampOffset(offset: number, docLength: number): number {
  return Math.min(Math.max(offset, 0), docLength);
}

function toDiagnostic(plugin: LSPPlugin, item: lsp.Diagnostic): Diagnostic {
  const docLength = plugin.view.state.doc.length;
  const from = clampOffset(plugin.fromPosition(item.range.start), docLength);
  const to = clampOffset(plugin.fromPosition(item.range.end), docLength);
  return {
    from: Math.min(from, to),
    to: Math.max(from, to),
    severity: toSeverity(item.severity),
    source: item.source,
    message: messageToString(item.message),
  };
}

const AUTO_SYNC_DELAY_MS = 500;

/** Deferred handle to a client — filled in once `new LSPClient(...)` returns,
 * since the extension is a constructor argument and can't reference the client
 * before it exists. */
export interface ClientRef {
  current: LSPClient | null;
}

/**
 * Per-client doc-change sync. Each mounted client gets its own autoSync that
 * syncs ITS client (via `ref`) — `LSPPlugin.get(view)` would only ever return
 * the first plugin (the type checker), so with multiple clients a shared
 * autoSync would never push edits to the linters.
 */
function buildAutoSync(ref: ClientRef): Extension {
  return ViewPlugin.fromClass(
    class {
      private pending: ReturnType<typeof setTimeout> | null = null;

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        if (this.pending) clearTimeout(this.pending);
        this.pending = setTimeout(() => {
          this.pending = null;
          ref.current?.sync();
        }, AUTO_SYNC_DELAY_MS);
      }

      destroy(): void {
        if (this.pending) clearTimeout(this.pending);
      }
    },
  );
}

/**
 * CodeMirror's stock `serverDiagnostics()` advertises version support and then
 * drops every diagnostic whose version differs from its local workspace file
 * version. Several npm language servers publish diagnostics with versions that
 * do not line up with our lightweight editor workspace, which made all non-TS
 * diagnostics appear to be missing. We don't advertise version support and map
 * diagnostics onto the current document instead.
 *
 * Phase 4: instead of REPLACING the whole lint set (which would clobber other
 * servers running on the same file), each client writes into its own bucket
 * keyed by `lspId` via `setServerDiagnostics`; `merged-diagnostics` flattens
 * the union. `autoSync` is per-client so every mounted server receives edits.
 */
export function cadencrServerDiagnostics(lspId: string, ref: ClientRef): LSPClientExtension {
  return {
    clientCapabilities: { textDocument: { publishDiagnostics: {} } },
    notificationHandlers: {
      "textDocument/publishDiagnostics": (c, params: lsp.PublishDiagnosticsParams) => {
        const file = c.workspace.getFile(params.uri);
        const view = file?.getView();
        const plugin = view ? LSPPlugin.get(view) : null;
        if (!view || !plugin) return false;
        const diagnostics = params.diagnostics.map((item) => toDiagnostic(plugin, item));
        view.dispatch({ effects: setServerDiagnostics.of({ lspId, diagnostics }) });
        return true;
      },
    },
    editorExtension: buildAutoSync(ref),
  };
}
