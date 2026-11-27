import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getReadFileQueryKey, useWriteFile } from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { useEditorStore } from "@/stores/editor-store";
import { readFileResponseFromContent } from "./editor-file-cache";

interface UseExcalidrawSaveArgs {
  projectId: number;
  featureId: number;
  paneId: string;
  filePath: string;
  /**
   * Serializes the current canvas to `.excalidraw` JSON, or returns `null`
   * when the scene isn't ready yet (API not mounted). Kept as a ref internally
   * so the returned `save` stays stable across canvas edits.
   */
  serialize: () => string | null;
  /** Called after a write succeeds — lets the editor reset its dirty baseline. */
  onSaved?: () => void;
}

interface UseExcalidrawSaveResult {
  /** Save the current scene; surfaces errors via toast. */
  save: () => Promise<void>;
  /** Save quietly (auto-save); flashes the "Auto-saved" status briefly. */
  saveQuiet: () => Promise<void>;
  /** True for ~1.5s after a successful auto-save — drives the status bar. */
  autoSavedVisible: boolean;
}

/**
 * Owns the Excalidraw editor's write path: the write mutation, read-file query
 * cache reconciliation, the dirty flag, and the transient "Auto-saved"
 * indicator. Mirrors `useEditorSave` but reads content from a `serialize`
 * callback (the canvas has no CodeMirror `EditorView`).
 */
export function useExcalidrawSave({
  projectId,
  featureId,
  paneId,
  filePath,
  serialize,
  onSaved,
}: UseExcalidrawSaveArgs): UseExcalidrawSaveResult {
  const queryClient = useQueryClient();
  const setDirty = useEditorStore((s) => s.setDirty);
  const [autoSavedVisible, setAutoSavedVisible] = useState(false);
  const autoSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const writeFile = useWriteFile();
  const mutateAsyncRef = useRef(writeFile.mutateAsync);
  mutateAsyncRef.current = writeFile.mutateAsync;

  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const readFileQueryKey = useMemo(
    () =>
      getReadFileQueryKey({ project_id: projectId, feature_id: featureId, file_path: filePath }),
    [projectId, featureId, filePath],
  );

  const write = useCallback(async (): Promise<string | null> => {
    const next = serializeRef.current();
    if (next === null) return null;
    await mutateAsyncRef.current({
      data: { project_id: projectId, feature_id: featureId, file_path: filePath, content: next },
    });
    // Keep the read-file cache in sync so remounting the tab shows the saved
    // scene, and clear the dirty flag now the backend has confirmed the write.
    queryClient.setQueryData(readFileQueryKey, readFileResponseFromContent(next));
    setDirty(featureId, paneId, filePath, false);
    onSavedRef.current?.();
    return next;
  }, [projectId, featureId, paneId, filePath, queryClient, readFileQueryKey, setDirty]);

  const save = useCallback(async () => {
    try {
      await write();
    } catch (err) {
      toastError(
        err,
        translateUi("workspace.editor.useExcalidrawSave.saveFailed", "Failed to save drawing"),
      );
    }
  }, [write]);

  const saveQuiet = useCallback(async () => {
    try {
      const saved = await write();
      if (saved === null) return;
      setAutoSavedVisible(true);
      if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
      autoSavedTimerRef.current = setTimeout(() => setAutoSavedVisible(false), 1500);
    } catch (err) {
      toastError(
        err,
        translateUi(
          "workspace.editor.useExcalidrawSave.autoSaveFailed",
          "Failed to auto-save drawing",
        ),
      );
    }
  }, [write]);

  useEffect(() => {
    return () => {
      if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
    };
  }, []);

  return { save, saveQuiet, autoSavedVisible };
}
