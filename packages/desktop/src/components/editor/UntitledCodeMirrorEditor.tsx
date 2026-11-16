/**
 * Editor view for a never-saved "untitled" scratch buffer. Renders a
 * blank CodeMirror, skips read/blame/LSP entirely (none of them have a
 * meaningful target before the buffer is saved), and routes CMD+S into
 * the native Save As dialog via `useSaveAsDialog`. After the file lands
 * on disk the parent unmounts this component and a real
 * `CodeMirrorEditor` keyed on the new path takes over.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { useEditorStore } from "@/stores/editor-store";
import { toastError } from "@/lib/api-errors";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";
import { EditorStatusBar } from "./EditorStatusBar";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import { useSaveAsDialog } from "./useSaveAsDialog";

interface UntitledCodeMirrorEditorProps {
  filePath: string; // `untitled://<uuid>`
  projectId: number;
  paneId: string;
  featureId: number;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

export default function UntitledCodeMirrorEditor({
  filePath,
  projectId,
  paneId,
  featureId,
  onEditorViewChange,
}: UntitledCodeMirrorEditorProps) {
  const viewRef = useRef<EditorView | null>(null);

  const setCursorPosition = useEditorStore((s) => s.setCursorPosition);
  // The tab can disappear before this subscriber unmounts. Keep the snapshot
  // stable then: allocating a fallback inside the selector loops in React (#185).
  const cursorPosition = useEditorStore(
    (s) =>
      s.features[featureId]?.panes[paneId]?.tabs.find((t) => t.filePath === filePath)
        ?.cursorPosition,
  ) ?? { line: 1, col: 1 };
  const suggestedName = useEditorStore(
    (s) =>
      s.features[featureId]?.panes[paneId]?.tabs.find((t) => t.filePath === filePath)?.fileName ??
      "Untitled",
  );

  const { saveAs, isSaving } = useSaveAsDialog({ projectId, featureId, paneId });

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      await saveAs(filePath, suggestedName, view.state.doc.toString());
    } catch (err) {
      // useSaveAsDialog already surfaces toasts for known errors, but a
      // bubbling unexpected error still deserves user-visible feedback.
      toastError(err, "Failed to save buffer");
    }
  }, [saveAs, filePath, suggestedName]);

  const handleSave = useCallback(() => {
    void save();
  }, [save]);

  const handleEditorViewChange = useCallback(
    (view: EditorView | null): void => {
      onEditorViewChange?.(paneId, view);
    },
    [onEditorViewChange, paneId],
  );

  // Track cursor for the status bar — same pattern as CodeMirrorEditor.
  const cursorExtension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) {
          const cursor = update.state.selection.main.head;
          const line = update.state.doc.lineAt(cursor);
          setCursorPosition(featureId, paneId, filePath, {
            line: line.number,
            col: cursor - line.from + 1,
          });
        }
      }),
    [setCursorPosition, featureId, paneId, filePath],
  );

  // `extraExtensions` is read only at mount inside BaseCodeMirrorEditor,
  // but we still keep the array reference stable so a parent re-render
  // doesn't push a fresh prop into the memoized child tree.
  const extraExtensions = useMemo(() => [cursorExtension], [cursorExtension]);

  // Register the same key in the save registry so existing call sites
  // (Save All, save-and-close prompt in EditorSubTabs) work uniformly.
  useEffect(() => {
    registerSave(paneId, filePath, save);
    return () => unregisterSave(paneId, filePath);
  }, [paneId, filePath, save]);

  return (
    <div className="h-full flex flex-col">
      <BaseCodeMirrorEditor
        initialContent=""
        onSave={handleSave}
        extraExtensions={extraExtensions}
        editorViewRef={viewRef}
        onEditorViewChange={handleEditorViewChange}
        className="flex-1 overflow-auto"
      />
      <EditorStatusBar
        line={cursorPosition.line}
        col={cursorPosition.col}
        language="Plain Text"
        autoSavedVisible={isSaving}
        lspStatus="unsupported"
        lspLanguageId={null}
      />
    </div>
  );
}
