/**
 * CodeMirror extension that turns CMD-click (macOS) / CTRL-click (Linux,
 * Windows) on a symbol into go-to-definition. We key on the modifier state
 * (`metaKey || ctrlKey`) rather than the resulting character so AZERTY users
 * and remapped keyboards aren't accidentally locked out.
 *
 * Delegates to [`jumpToDefinitionCommand`] (our toast-wrapped wrapper) so
 * server errors surface as a sonner toast rather than the buffer-top banner
 * `@codemirror/lsp-client` paints by default.
 *
 * When the jump is a no-op because the server isn't usable, we nudge the user
 * — distinguishing "still starting" (wait) from "reconnecting"/"failed"
 * (transient death / give-up) so a re-broken session re-hints correctly. The
 * hint is suppressed only briefly per view (a time window, not forever) so a
 * server that breaks again later still hints again.
 */
import { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { toast } from "sonner";
import { jumpToDefinitionCommand } from "./definition";
import { getLspStatus } from "./client-manager";

/** Per-view timestamp of the last "not ready" hint. A fresh hint is only
 * shown once this window has elapsed, so we don't spam while a server indexes
 * but DO re-hint after a later breakage. */
const lastHintAt = new WeakMap<EditorView, number>();
const HINT_SUPPRESS_MS = 8_000;

interface ModClickArgs {
  /** Resolved LSP root + the type checker's server id, for live status lookup
   * at click time (status is keyed by `(root, lspId)`). */
  resolvedRoot: string | null;
  languageId: string | null;
}

function shouldHint(view: EditorView): boolean {
  const now = Date.now();
  const prev = lastHintAt.get(view);
  if (prev != null && now - prev < HINT_SUPPRESS_MS) return false;
  lastHintAt.set(view, now);
  return true;
}

/** @public */
export function lspModClickExtension(
  args: ModClickArgs,
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      // Only left-clicks with the modifier.
      if (event.button !== 0) return false;
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      // Move the cursor to the click target — the command reads the
      // selection head — then fire. We swallow the event so the browser
      // doesn't also start a text selection or open a context menu.
      view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
      event.preventDefault();
      if (jumpToDefinitionCommand(view)) return true;

      // Silent no-op = unsupported file (no LSP plugin) OR server not usable.
      // For unsupported files the status-bar indicator already makes that
      // obvious. If the plugin is mounted, tell the user what's wrong.
      if (!LSPPlugin.get(view) || !shouldHint(view)) return true;
      const status =
        args.resolvedRoot && args.languageId
          ? getLspStatus(args.resolvedRoot, args.languageId)?.status
          : undefined;
      if (status === "error") {
        toast.error("Language server failed — click the status indicator to retry.");
      } else if (status === "reconnecting") {
        toast.warning("Language server reconnecting — try again in a moment.");
      } else {
        toast.info("Language server is still starting — try again in a moment.");
      }
      return true;
    },
  });
}
