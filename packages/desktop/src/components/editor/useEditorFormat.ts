/**
 * Document formatting for the editor: a manual "Format document" command and
 * the format-on-save hook. Both run the project's configured formatter CLI via
 * `POST /api/editor/format` (binary resolved server-side through cli-discovery)
 * and apply the returned text as a single edit. Errors surface as a toast — a
 * parse/config error in the formatter must never be swallowed.
 */
import { useCallback, useMemo } from "react";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { toast } from "sonner";
import { format } from "@/api/generated";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { useProjectEditorTooling } from "@/lib/lsp/useProjectEditorTooling";

interface UseEditorFormatArgs {
  projectId: number;
  featureId: number;
  filePath: string;
  viewRef: RefObject<EditorView | null>;
  /** Large read-only buffers never format. */
  largeMode: boolean;
}

interface UseEditorFormatResult {
  /** Format the buffer in place. No-op + returns false when no formatter is
   * configured. Surfaces formatter errors as a toast. */
  formatDocument: () => Promise<boolean>;
  /** Pre-save step for `useEditorSave.beforeWrite` when format-on-save is on;
   * `undefined` (stable) otherwise so the save callback stays stable. */
  beforeWrite: (() => Promise<void>) | undefined;
}

/** Apply `formatted` to the view, preserving the cursor offset when possible. */
function applyFormatted(view: EditorView, formatted: string): void {
  const current = view.state.doc.toString();
  if (formatted === current) return;
  const anchor = Math.min(view.state.selection.main.head, formatted.length);
  view.dispatch({
    changes: { from: 0, to: current.length, insert: formatted },
    selection: { anchor },
    userEvent: "format",
  });
}

/** @public */
export function useEditorFormat({
  projectId,
  featureId,
  filePath,
  viewRef,
  largeMode,
}: UseEditorFormatArgs): UseEditorFormatResult {
  const tooling = useProjectEditorTooling(projectId);
  const canFormat = tooling.formatter !== "off";

  const formatDocument = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view || tooling.formatter === "off") return false;
    try {
      const { content } = await format({
        project_id: projectId,
        feature_id: featureId,
        file_path: filePath,
        content: view.state.doc.toString(),
        formatter: tooling.formatter,
      });
      // The view may have changed identity between request and response.
      const live = viewRef.current;
      if (live) applyFormatted(live, content);
      return true;
    } catch (err) {
      const detail =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err instanceof Error ? err.message : "Failed to format document");
      toast.error(detail);
      return false;
    }
  }, [projectId, featureId, filePath, tooling.formatter, viewRef]);

  // Manual "Format document" command (⌘⇧I). Capture-phase so it fires while
  // focus is inside the CodeMirror buffer; gated on a configured formatter.
  useScopedGlobalShortcutById(
    "editor-format-document",
    (e) => {
      e.preventDefault();
      void formatDocument();
    },
    "editor",
    { enabled: canFormat && !largeMode },
  );

  const beforeWrite = useMemo(() => {
    if (!canFormat || !tooling.formatOnSave || largeMode) return undefined;
    return async (): Promise<void> => {
      await formatDocument();
    };
  }, [canFormat, tooling.formatOnSave, largeMode, formatDocument]);

  return { formatDocument, beforeWrite };
}
