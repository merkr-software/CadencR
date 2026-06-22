/**
 * Cadencr go-to-definition.
 *
 * Wraps `textDocument/definition` directly instead of using
 * `jumpToDefinition` from `@codemirror/lsp-client`. The library version
 * surfaces failures via `plugin.reportError`, which paints a red banner
 * at the top of the editor buffer — that's loud and persists until the
 * user dismisses it. Cadencr surfaces transient errors as toasts so the
 * editor chrome stays clean, and that requires owning the error path.
 *
 * The capability check and `withMapping` ceremony mirror the library so
 * the only behavioral difference is *where* failures are displayed.
 *
 * One important deviation: when the user clicks before the server has
 * finished initializing (`serverCapabilities` is still null — common right
 * after landing on a file via go-to-definition, when its language server is
 * still starting), we DEFER the jump until the server is ready instead of
 * silently doing nothing. Previously the click no-op'd and only worked after
 * reopening the file, which read as "Cmd+Click is broken on the second file".
 */
import { type EditorView, type Command, type KeyBinding } from "@codemirror/view";
import { LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import { toast } from "sonner";

// Subset of LSP 3.17 we actually use. Inlined rather than pulling in
// `vscode-languageserver-protocol` as a direct dep — the only
// runtime carrier of these types is the JSON-RPC wire.
interface LspPosition {
  line: number;
  character: number;
}
interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}
interface DefinitionParams {
  textDocument: { uri: string };
  position: LspPosition;
}
type DefinitionResponse = LspLocation | LspLocation[] | null;

/** How long we wait for a starting server's `initialize` before giving up. A
 * cold tsserver loading a large project can take several seconds. */
const INIT_TIMEOUT_MS = 20_000;
/** Only surface a "starting…" toast if the wait is actually noticeable, so a
 * fast/already-ready server doesn't flash a spinner. */
const SLOW_TOAST_DELAY_MS = 400;

/** Views with a deferred jump already in flight, so impatient repeat clicks on
 * a cold server don't stack timers, toasts, and duplicate definition requests. */
const deferredJumps = new WeakSet<EditorView>();

/**
 * Run the jump. Returns `true` when the command was applicable (there was an
 * LSP plugin), so the keymap can swallow the event. When the server hasn't
 * finished initializing, the jump is deferred (still returns `true`) rather
 * than dropped. Errors surface as a single toast.
 */
function runJumpToDefinition(view: EditorView): boolean {
  // With multiple clients mounted (type checker + linters), `LSPPlugin.get`
  // returns the FIRST mounted lspPlugin. `useLsp` mounts the type checker's
  // plugin first precisely so navigation targets it, not a linter.
  const plugin = LSPPlugin.get(view);
  if (!plugin) return false;
  const caps = plugin.client.serverCapabilities;
  if (caps) {
    if (!caps.definitionProvider) return false;
    executeJump(view, plugin);
    return true;
  }
  // Server still initializing — defer instead of no-op'ing. We swallow the
  // event (return true) so the click doesn't start a text selection while we
  // wait for the server to come up.
  void jumpWhenReady(view, plugin.client);
  return true;
}

/** Wait for `client` to finish initializing (bounded), then jump. Re-reads the
 * live plugin after the wait because the editor may have remounted or closed
 * while the server was starting. */
async function jumpWhenReady(view: EditorView, client: LSPClient): Promise<void> {
  if (deferredJumps.has(view)) return;
  deferredJumps.add(view);
  let toastId: string | number | undefined;
  const slowTimer = setTimeout(() => {
    toastId = toast.loading("Starting language server…");
  }, SLOW_TOAST_DELAY_MS);
  try {
    const ready = await initialized(client);
    // The plugin is gone iff the editor was closed/remounted while we waited —
    // drop the stale jump silently rather than toasting about a file the user
    // already left.
    const plugin = LSPPlugin.get(view);
    if (!plugin) return;
    if (!ready) {
      toast.error("Go to definition: language server didn't finish starting.");
      return;
    }
    if (!plugin.client.serverCapabilities?.definitionProvider) return;
    executeJump(view, plugin);
  } finally {
    clearTimeout(slowTimer);
    if (toastId !== undefined) toast.dismiss(toastId);
    deferredJumps.delete(view);
  }
}

/** Resolve `true` once the client's `initialize` handshake completes, or
 * `false` if it doesn't within [`INIT_TIMEOUT_MS`]. `LSPClient.initializing`
 * resolves on init, so we race it against a timeout instead of polling. */
function initialized(client: LSPClient): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), INIT_TIMEOUT_MS);
  });
  return Promise.race([client.initializing.then(() => true), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** Issue the `textDocument/definition` request and move the cursor to the
 * result (opening the target file via the workspace if it's elsewhere). */
function executeJump(view: EditorView, plugin: LSPPlugin): void {
  plugin.client.sync();
  void plugin.client.withMapping(async (mapping) => {
    try {
      const response = await plugin.client.request<DefinitionParams, DefinitionResponse>(
        "textDocument/definition",
        {
          textDocument: { uri: plugin.uri },
          position: plugin.toPosition(view.state.selection.main.head),
        },
      );
      const loc = Array.isArray(response) ? response[0] : response;
      if (!loc) return;

      const target =
        loc.uri === plugin.uri ? view : await plugin.client.workspace.displayFile(loc.uri);
      if (!target) return;

      const pos = mapping.getMapping(loc.uri)
        ? mapping.mapPosition(loc.uri, loc.range.start)
        : plugin.fromPosition(loc.range.start, target.state.doc);
      target.dispatch({
        selection: { anchor: pos },
        scrollIntoView: true,
        userEvent: "select.definition",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Go to definition failed: ${msg}`);
    }
  });
}

/** @public */
export const jumpToDefinitionCommand: Command = runJumpToDefinition;

/** F12 binding for the toast-wrapped jump. */
export const jumpToDefinitionKeymap: readonly KeyBinding[] = [
  { key: "F12", run: jumpToDefinitionCommand, preventDefault: true },
];
