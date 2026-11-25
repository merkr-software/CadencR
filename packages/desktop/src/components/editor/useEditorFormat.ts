import { translateUi } from "@/lib/i18n/ui";
/**
 * Document formatting for the editor: a manual "Format document" command and
 * the format-on-save hook. Both run the project's configured formatter CLI via
 * `POST /api/editor/format` (binary resolved server-side through cli-discovery)
 * and apply the returned text as a single edit. Errors surface as a toast — a
 * parse/config error in the formatter must never be swallowed.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { toast } from "sonner";
import { format } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
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
  isFormatting: boolean;
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
  const [pendingFormats, setPendingFormats] = useState(0);
  const isFormatting = pendingFormats > 0;
  const requestRef = useRef(0);
  const canFormat = tooling.formatter !== "off";

  const formatDocument = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view || largeMode || tooling.formatter === "off") return false;
    const doc = view.state.doc;
    const request = ++requestRef.current;
    setPendingFormats((count) => count + 1);
    try {
      const { content } = await format({
        project_id: projectId,
        feature_id: featureId,
        file_path: filePath,
        content: doc.toString(),
        formatter: tooling.formatter,
      });
      // A formatter response only owns the exact document it was requested for.
      if (request !== requestRef.current || viewRef.current !== view || view.state.doc !== doc) {
        return false;
      }
      applyFormatted(view, content);
      return true;
    } catch (err) {
      toast.error(
        apiErrorMessage(
          err,
          translateUi("workspace.editor.useEditorFormat.formatFailed", "Failed to format document"),
        ),
      );
      return false;
    } finally {
      setPendingFormats((count) => count - 1);
    }
  }, [largeMode, projectId, featureId, filePath, tooling.formatter, viewRef]);

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

  return useMemo(
    () => ({ formatDocument, beforeWrite, isFormatting }),
    [formatDocument, beforeWrite, isFormatting],
  );
}
