import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { toastError } from "@/lib/api-errors";
import { useEditorStore } from "@/stores/editor-store";
import { EditorOperationError, editorErrorMessage, editorSyncFailed } from "./editor-error-message";
import { useEditorWrite } from "./useEditorWrite";
import { useFreshFileContentSync } from "./useFreshFileContentSync";

interface UseEditorSaveArgs {
  projectId: number;
  featureId: number;
  paneId: string;
  filePath: string;
  /** Loaded file content, forwarded to the fresh-content sync hook. */
  content: string | undefined;
  viewRef: RefObject<EditorView | null>;
  /**
   * Optional pre-save step (format-on-save). Runs and is awaited BEFORE the
   * buffer is read for writing, so the formatted text is what gets persisted.
   * The formatter handles its own failures so the current buffer can still
   * be saved. A rejecting callback aborts the write and surfaces a save error.
   */
  beforeWrite?: () => Promise<void>;
}

interface UseEditorSaveResult {
  /** Save the current buffer; surfaces errors via toast. */
  save: () => Promise<void>;
  /** Rejects failures and concurrent edits so close/leave guards cannot discard them. */
  saveForClose: () => Promise<void>;
  /** Save quietly (auto-save); flashes the "Auto-saved" status briefly. */
  saveQuiet: () => Promise<void>;
  /** True for ~1.5s after a successful auto-save — drives the status bar. */
  autoSavedVisible: boolean;
  /** Visible async/error state for save controls outside the normal status bar. */
  isSaving: boolean;
  errorMessage: string | null;
  diskChanged: boolean;
  onDocChange: ReturnType<typeof useFreshFileContentSync>["onDocChange"];
  reloadFromDisk: () => Promise<void>;
  overwriteDisk: () => Promise<void>;
}

/**
 * Owns the editor's write path: the write mutation, query-cache reconciliation,
 * the dirty flag, and the transient "Auto-saved" indicator. Extracted from
 * `CodeMirrorEditor` to keep that component under the file-size cap.
 */
export function useEditorSave({
  projectId,
  featureId,
  paneId,
  filePath,
  content,
  viewRef,
  beforeWrite,
}: UseEditorSaveArgs): UseEditorSaveResult {
  const setDirty = useEditorStore((s) => s.setDirty);
  const [autoSavedVisible, setAutoSavedVisible] = useState(false);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const autoSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      setDirty(featureId, paneId, filePath, dirty);
    },
    [featureId, paneId, filePath, setDirty],
  );
  const sync = useFreshFileContentSync({ content, viewRef, onDirtyChange });
  const { write, reload } = useEditorWrite({
    projectId,
    featureId,
    filePath,
    viewRef,
    beforeWrite,
    sync,
  });

  const { clear, report, errorMessage } = useEditorSyncError();
  const run = useCallback(
    async (operation: () => Promise<unknown>, propagate = false) => {
      setPendingSaveCount((count) => count + 1);
      clear();
      try {
        await operation();
      } catch (err) {
        report(err);
        if (propagate) throw err;
      } finally {
        setPendingSaveCount((count) => Math.max(0, count - 1));
      }
    },
    [clear, report],
  );
  const save = useCallback(() => run(() => write(false)), [run, write]);
  const saveForClose = useCallback(
    () => run(() => writeAndCheckDirty(write, sync.dirtyRef), true),
    [run, write, sync.dirtyRef],
  );
  const overwriteDisk = useCallback(() => run(() => write(false, true)), [run, write]);
  const reloadFromDisk = useCallback(() => run(reload), [run, reload]);

  const saveQuiet = useCallback(
    () =>
      run(async () => {
        if ((await write(true)) === null) return;
        setAutoSavedVisible(true);
        if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
        autoSavedTimerRef.current = setTimeout(() => setAutoSavedVisible(false), 1500);
      }),
    [run, write],
  );

  useEffect(() => {
    return () => {
      if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
    };
  }, []);

  return useMemo(
    () => ({
      save,
      saveQuiet,
      saveForClose,
      autoSavedVisible,
      isSaving: pendingSaveCount > 0,
      errorMessage,
      diskChanged: sync.diskChanged,
      onDocChange: sync.onDocChange,
      reloadFromDisk,
      overwriteDisk,
    }),
    [
      autoSavedVisible,
      errorMessage,
      pendingSaveCount,
      save,
      saveQuiet,
      saveForClose,
      sync.diskChanged,
      sync.onDocChange,
      reloadFromDisk,
      overwriteDisk,
    ],
  );
}

async function writeAndCheckDirty(
  write: ReturnType<typeof useEditorWrite>["write"],
  dirtyRef: RefObject<boolean>,
) {
  await write(false);
  if (dirtyRef.current) {
    throw new EditorOperationError(
      "The buffer still has unsaved changes. Please save again before closing.",
      (t) =>
        t(
          "workspace.editor.save.stillUnsaved",
          "The buffer still has unsaved changes. Please save again before closing.",
        ),
    );
  }
}

function useEditorSyncError() {
  const { t } = useUiTranslation();
  const [failure, setFailure] = useState<{ reason: unknown } | null>(null);
  const clear = useCallback(() => setFailure(null), []);
  const report = useCallback((reason: unknown) => {
    setFailure({ reason });
    const fallback =
      reason instanceof EditorOperationError
        ? reason.localize(translateUi)
        : editorSyncFailed(translateUi);
    toastError(reason instanceof EditorOperationError ? null : reason, fallback);
  }, []);
  const errorMessage = failure ? editorErrorMessage(failure.reason, editorSyncFailed(t), t) : null;
  return { clear, report, errorMessage };
}
