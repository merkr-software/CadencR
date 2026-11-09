/**
 * In-editor canvas editor for `.excalidraw` scene files. Instead of showing
 * the raw JSON in CodeMirror, this mounts the embedded Excalidraw component so
 * the drawing opens directly on a canvas.
 *
 * The `.excalidraw` file is JSON (`{ elements, appState, files }`); we parse it
 * into `initialData`, render the canvas, and persist edits back with
 * `serializeAsJSON` via the shared write path (`useExcalidrawSave`). Dirty
 * tracking uses `getSceneVersion` so selection/scroll noise from `onChange`
 * doesn't flag the buffer as modified. Lazy-loaded by `EditorPane` so the large
 * Excalidraw bundle only downloads when such a file is opened.
 */
// Side-effect import: sets `window.EXCALIDRAW_ASSET_PATH` to our self-hosted
// fonts. Must precede the `@excalidraw/excalidraw` import so it runs first.
import "./excalidraw-asset-path";
import { Excalidraw, getSceneVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { useReadFile } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { useSetting } from "@/hooks/useSetting";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { getFileName } from "@/lib/file-language";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import { useExcalidrawSave } from "./useExcalidrawSave";
import { parseScene, type ParsedScene } from "./excalidraw-scene";

interface ExcalidrawEditorProps {
  filePath: string;
  projectId: number;
  featureId: number;
  paneId: string;
}

const AUTO_SAVE_DELAY_MS = 1500;

type SetEditorDirty = ReturnType<typeof useEditorStore.getState>["setDirty"];

function useSceneSerializer(
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
  lastSerializedVersionRef: MutableRefObject<number | null>,
): () => string | null {
  return useCallback((): string | null => {
    const api = apiRef.current;
    if (!api) return null;
    const elements = api.getSceneElements();
    lastSerializedVersionRef.current = getSceneVersion(elements);
    return serializeAsJSON(elements, api.getAppState(), api.getFiles(), "local");
  }, [apiRef, lastSerializedVersionRef]);
}

function useSceneSavedHandler(
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
  lastSerializedVersionRef: MutableRefObject<number | null>,
  baselineVersionRef: MutableRefObject<number | null>,
  isDirtyRef: MutableRefObject<boolean>,
  setDirty: SetEditorDirty,
  featureId: number,
  paneId: string,
  filePath: string,
): () => void {
  return useCallback(() => {
    const savedVersion = lastSerializedVersionRef.current;
    baselineVersionRef.current = savedVersion;
    const api = apiRef.current;
    const liveVersion = api ? getSceneVersion(api.getSceneElements()) : savedVersion;
    if (savedVersion !== null && liveVersion !== savedVersion) {
      isDirtyRef.current = true;
      setDirty(featureId, paneId, filePath, true);
    } else {
      isDirtyRef.current = false;
    }
  }, [
    apiRef,
    baselineVersionRef,
    featureId,
    filePath,
    isDirtyRef,
    lastSerializedVersionRef,
    paneId,
    setDirty,
  ]);
}

function useSceneChangeHandler(
  baselineVersionRef: MutableRefObject<number | null>,
  isDirtyRef: MutableRefObject<boolean>,
  autoSaveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  isAutoSaveEnabledRef: MutableRefObject<boolean>,
  saveQuiet: () => Promise<void>,
  setDirty: SetEditorDirty,
  featureId: number,
  paneId: string,
  filePath: string,
): (elements: Parameters<typeof getSceneVersion>[0]) => void {
  const markClean = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (!isDirtyRef.current) return;
    isDirtyRef.current = false;
    setDirty(featureId, paneId, filePath, false);
  }, [autoSaveTimerRef, featureId, filePath, isDirtyRef, paneId, setDirty]);
  return useCallback(
    (elements) => {
      const version = getSceneVersion(elements);
      if (baselineVersionRef.current === null) {
        baselineVersionRef.current = version;
        return;
      }
      if (version === baselineVersionRef.current) {
        markClean();
        return;
      }
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        setDirty(featureId, paneId, filePath, true);
      }
      if (isAutoSaveEnabledRef.current) {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => void saveQuiet(), AUTO_SAVE_DELAY_MS);
      }
    },
    [
      autoSaveTimerRef,
      baselineVersionRef,
      featureId,
      filePath,
      isAutoSaveEnabledRef,
      isDirtyRef,
      markClean,
      paneId,
      saveQuiet,
      setDirty,
    ],
  );
}

function useParsedExcalidrawScene(filePath: string, projectId: number, featureId: number) {
  const { data, error: readError } = useReadFile(
    { project_id: projectId, feature_id: featureId, file_path: filePath },
    {
      query: {
        enabled: Boolean(filePath && projectId),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  );
  const parsedRef = useRef<ParsedScene | null>(null);
  if (parsedRef.current === null && data !== undefined) {
    parsedRef.current = parseScene(data.content);
  }
  const { initialData, error: parseError } = parsedRef.current ?? {
    initialData: null,
    error: null,
  };
  useEffect(() => {
    if (parseError) toast.error(parseError, { id: `excalidraw:${filePath}` });
  }, [filePath, parseError]);
  const errorMessage = parseError ?? (readError instanceof Error ? readError.message : null);
  return useMemo(() => ({ initialData, errorMessage }), [errorMessage, initialData]);
}

interface ExcalidrawEditorViewProps {
  fileName: string;
  errorMessage: string | null;
  initialData: ParsedScene["initialData"];
  autoSavedVisible: boolean;
  onApi: (api: ExcalidrawImperativeAPI) => void;
  onChange: (elements: Parameters<typeof getSceneVersion>[0]) => void;
}

function ExcalidrawEditorView({
  fileName,
  errorMessage,
  initialData,
  autoSavedVisible,
  onApi,
  onChange,
}: ExcalidrawEditorViewProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 relative">
        {errorMessage ? (
          <div className="h-full flex items-center justify-center text-destructive text-sm px-6 text-center">
            {errorMessage}
          </div>
        ) : initialData === null ? (
          <div className="h-full flex items-center justify-center bg-background">
            <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Excalidraw excalidrawAPI={onApi} initialData={initialData} onChange={onChange} />
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-0.5 border-t border-border bg-card text-xs text-muted-foreground shrink-0">
        <span className="truncate">{fileName}</span>
        {autoSavedVisible ? <span>Auto-saved</span> : null}
      </div>
    </div>
  );
}

function ExcalidrawEditorImpl({ filePath, projectId, featureId, paneId }: ExcalidrawEditorProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Baseline scene version for dirty detection. `null` until the first
  // `onChange` records the loaded scene (Excalidraw's `restore` may re-stamp
  // element versions, so we can't trust the parsed file's version directly).
  const baselineVersionRef = useRef<number | null>(null);
  const lastSerializedVersionRef = useRef<number | null>(null);
  const isDirtyRef = useRef(false);

  const setDirty = useEditorStore((s) => s.setDirty);
  const isFocusedPane = useEditorStore((s) => s.features[featureId]?.activePaneId === paneId);

  const { value: autoSaveSetting } = useSetting("editor_auto_save");
  const isAutoSaveEnabledRef = useRef(false);
  isAutoSaveEnabledRef.current = (autoSaveSetting ?? "false") === "true";

  const { initialData, errorMessage } = useParsedExcalidrawScene(filePath, projectId, featureId);

  const serialize = useSceneSerializer(apiRef, lastSerializedVersionRef);
  const handleSaved = useSceneSavedHandler(
    apiRef,
    lastSerializedVersionRef,
    baselineVersionRef,
    isDirtyRef,
    setDirty,
    featureId,
    paneId,
    filePath,
  );

  const { save, saveQuiet, autoSavedVisible } = useExcalidrawSave({
    projectId,
    featureId,
    paneId,
    filePath,
    serialize,
    onSaved: handleSaved,
  });

  const handleChange = useSceneChangeHandler(
    baselineVersionRef,
    isDirtyRef,
    autoSaveTimerRef,
    isAutoSaveEnabledRef,
    saveQuiet,
    setDirty,
    featureId,
    paneId,
    filePath,
  );

  // ⌘S. CodeMirror binds save inside its own keymap; the canvas has none, so
  // we bind the registry chord here, gated to the focused pane so it never
  // fights a CodeMirror pane's binding in a split layout.
  useScopedGlobalShortcutById(
    "editor-save",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      void save();
    },
    "editor",
    { enabled: isFocusedPane },
  );

  // Register with the save registry so "Save All" and close-tab prompts reach
  // the canvas the same way they reach CodeMirror buffers.
  useEffect(() => {
    registerSave(paneId, filePath, save);
    return () => unregisterSave(paneId, filePath);
  }, [paneId, filePath, save]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  return (
    <ExcalidrawEditorView
      fileName={getFileName(filePath)}
      errorMessage={errorMessage}
      initialData={initialData}
      autoSavedVisible={autoSavedVisible}
      onApi={handleApi}
      onChange={handleChange}
    />
  );
}

const ExcalidrawEditor = memo(ExcalidrawEditorImpl);
export default ExcalidrawEditor;
