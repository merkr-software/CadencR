import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useGetBlame, useGetFeatureWorkingDir, useReadFile } from "@/api/generated";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useEditorLanguage } from "@/hooks/useEditorLanguage";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { setGitGutterBaseline } from "@/lib/editor/git-gutter/git-gutter-extension";
import { useGitGutter } from "@/lib/editor/git-gutter/useGitGutter";
import { getPreviewKind } from "@/lib/file-language";
import { useLsp } from "@/lib/lsp/useLsp";
import { useEditorStore } from "@/stores/editor-store";
import { scrollToEditorLine } from "./editor-lines";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import { gitBlameExtension } from "./git-blame-extension";
import { getLanguageExtension } from "./language-extensions";
import { useEditorFormat } from "./useEditorFormat";
import { useEditorSave } from "./useEditorSave";
import { useLargeFileMode } from "./useLargeFileMode";

export interface CodeMirrorEditorProps {
  filePath: string;
  projectId: number;
  paneId: string;
  featureId: number;
  searchOpen: boolean;
  searchReopenSignal: number;
  searchReplaceMode?: boolean;
  searchReplaceFocusSignal?: number;
  goToLineOpen?: boolean;
  goToLineReopenSignal?: number;
  onCloseSearch: () => void;
  onCloseGoToLine?: () => void;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

const AUTO_SAVE_DELAY_MS = 1500;

function useEditorFileData(props: CodeMirrorEditorProps) {
  const language = useEditorLanguage(props.projectId, props.filePath);
  const { value: vimModeLevelSetting } = useDebouncedSetting("editor_vim_mode_level");
  const { value: autoSaveSetting } = useDebouncedSetting("editor_auto_save");
  const { value: gitBlameSetting } = useDebouncedSetting("editor_git_blame");
  const fileQuery = useReadFile(
    {
      project_id: props.projectId,
      feature_id: props.featureId,
      file_path: props.filePath,
    },
    {
      query: {
        enabled: Boolean(props.filePath && props.projectId),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  );
  const largeFile = useLargeFileMode({
    large: fileQuery.data?.large,
    content: fileQuery.data?.content,
  });
  const workingDir = useGetFeatureWorkingDir(
    props.featureId,
    { project_id: props.projectId },
    {
      query: { enabled: Boolean(props.featureId && props.projectId), refetchOnWindowFocus: false },
    },
  );
  const lsp = useLsp({
    workspaceRoot: workingDir.data?.path ?? undefined,
    filePath: props.filePath,
    projectId: props.projectId,
    featureId: props.featureId,
    paneId: props.paneId,
    editorLanguageId: language.languageId,
    enabled: !largeFile.largeMode,
  });
  const isBlameEnabled = (gitBlameSetting ?? "false") === "true";
  const blame = useGetBlame(
    {
      project_id: props.projectId,
      feature_id: props.featureId,
      file_path: props.filePath,
    },
    {
      query: {
        enabled:
          isBlameEnabled && !largeFile.largeMode && Boolean(props.projectId && props.filePath),
        refetchOnWindowFocus: false,
      },
    },
  );
  const gitGutter = useGitGutter({
    projectId: props.projectId,
    featureId: props.featureId,
    filePath: props.filePath,
    enabled: !largeFile.largeMode,
  });
  const vimModeLevel = vimModeLevelSetting ?? "0";
  return {
    blame,
    fileQuery,
    gitGutter,
    isAutoSaveEnabled: (autoSaveSetting ?? "false") === "true",
    isBlameEnabled,
    // Level 1 keeps using @replit/codemirror-vim, unchanged from before this setting split.
    isVimEnabled: vimModeLevel === "1",
    language,
    largeFile,
    lsp,
    workspaceRoot: workingDir.data?.path ?? undefined,
  };
}

type EditorFileData = ReturnType<typeof useEditorFileData>;

function useEditorExtensionSync(
  data: EditorFileData,
  editorView: EditorView | null,
  viewRef: React.RefObject<EditorView | null>,
  blameCompartment: React.RefObject<Compartment>,
  lspCompartment: React.RefObject<Compartment>,
) {
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const extension =
      data.isBlameEnabled && data.blame.data ? gitBlameExtension(data.blame.data.lines) : [];
    view.dispatch({ effects: blameCompartment.current.reconfigure(extension) });
  }, [blameCompartment, data.blame.data, data.fileQuery.data, data.isBlameEnabled, viewRef]);
  useEffect(() => {
    if (!editorView) return;
    editorView.dispatch({ effects: lspCompartment.current.reconfigure(data.lsp.extension) });
  }, [data.lsp.extension, editorView, lspCompartment]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setGitGutterBaseline.of(data.gitGutter.baseline) });
  }, [data.fileQuery.data, data.gitGutter.baseline, viewRef]);
}

interface BufferLifecycleInput {
  props: CodeMirrorEditorProps;
  data: EditorFileData;
  editorView: EditorView | null;
  viewRef: React.RefObject<EditorView | null>;
  autoSaveTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  save: ReturnType<typeof useEditorSave>["save"];
  clearPendingGoToLine: ReturnType<typeof useEditorStore.getState>["clearPendingGoToLine"];
  pendingGoToLine: number | undefined;
  setDirty: ReturnType<typeof useEditorStore.getState>["setDirty"];
}

function useBufferLifecycle(input: BufferLifecycleInput) {
  const { props } = input;
  useEffect(() => {
    registerSave(props.paneId, props.filePath, input.save);
    return () => unregisterSave(props.paneId, props.filePath);
  }, [input.save, props.filePath, props.paneId]);
  useEffect(
    () => () => {
      if (input.autoSaveTimerRef.current) clearTimeout(input.autoSaveTimerRef.current);
    },
    [input.autoSaveTimerRef],
  );
  useEffect(() => {
    input.setDirty(props.featureId, props.paneId, props.filePath, false);
  }, [input.setDirty, props.featureId, props.filePath, props.paneId]);
  useEffect(() => {
    if (!input.editorView || !input.data.fileQuery.data || input.pendingGoToLine == null) return;
    scrollToEditorLine(input.editorView, input.pendingGoToLine);
    input.clearPendingGoToLine(props.featureId, props.paneId, props.filePath);
  }, [
    input.clearPendingGoToLine,
    input.data.fileQuery.data,
    input.editorView,
    input.pendingGoToLine,
    props.featureId,
    props.filePath,
    props.paneId,
  ]);
}

function useEditorBuffer(props: CodeMirrorEditorProps, data: EditorFileData) {
  const viewRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveEnabledRef = useRef(data.isAutoSaveEnabled);
  autoSaveEnabledRef.current = data.isAutoSaveEnabled;
  const blameCompartment = useRef(new Compartment());
  const lspCompartment = useRef(new Compartment());
  const setDirty = useEditorStore((state) => state.setDirty);
  const setCursorPosition = useEditorStore((state) => state.setCursorPosition);
  const clearPendingGoToLine = useEditorStore((state) => state.clearPendingGoToLine);
  const cursorPosition = useEditorStore(
    (state) =>
      state.features[props.featureId]?.panes[props.paneId]?.tabs.find(
        (candidate) => candidate.filePath === props.filePath,
      )?.cursorPosition,
  );
  const pendingGoToLine = useEditorStore(
    (state) =>
      state.features[props.featureId]?.panes[props.paneId]?.tabs.find(
        (candidate) => candidate.filePath === props.filePath,
      )?.pendingGoToLine,
  );
  const { beforeWrite } = useEditorFormat({
    projectId: props.projectId,
    featureId: props.featureId,
    filePath: props.filePath,
    viewRef,
    largeMode: data.largeFile.largeMode,
  });
  const saveState = useEditorSave({
    projectId: props.projectId,
    featureId: props.featureId,
    paneId: props.paneId,
    filePath: props.filePath,
    content: data.fileQuery.data?.content,
    viewRef,
    beforeWrite,
  });
  const handleChange = useCallback((): void => {
    if (data.largeFile.largeMode) return;
    setDirty(props.featureId, props.paneId, props.filePath, true);
    if (!autoSaveEnabledRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => void saveState.saveQuiet(), AUTO_SAVE_DELAY_MS);
  }, [data.largeFile.largeMode, props, saveState.saveQuiet, setDirty]);
  const handleEditorViewChange = useCallback(
    (view: EditorView | null): void => {
      setEditorView(view);
      props.onEditorViewChange?.(props.paneId, view);
    },
    [props],
  );
  const cursorExtension = useMemo(
    () =>
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const cursor = update.state.selection.main.head;
        const line = update.state.doc.lineAt(cursor);
        setCursorPosition(props.featureId, props.paneId, props.filePath, {
          line: line.number,
          col: cursor - line.from + 1,
        });
      }),
    [props.featureId, props.filePath, props.paneId, setCursorPosition],
  );
  useEditorExtensionSync(data, editorView, viewRef, blameCompartment, lspCompartment);
  useBufferLifecycle({
    props,
    data,
    editorView,
    viewRef,
    autoSaveTimerRef,
    save: saveState.save,
    clearPendingGoToLine,
    pendingGoToLine,
    setDirty,
  });
  return {
    autoSavedVisible: saveState.autoSavedVisible,
    blameCompartment,
    cursorExtension,
    cursorPosition: cursorPosition ?? { line: 1, col: 1 },
    editorView,
    handleChange,
    handleEditorViewChange,
    handleSave: (): void => void saveState.save(),
    lspCompartment,
    viewRef,
  };
}

type EditorBuffer = ReturnType<typeof useEditorBuffer>;

function useEditorPreview(
  props: CodeMirrorEditorProps,
  data: EditorFileData,
  buffer: EditorBuffer,
) {
  const [content, setContent] = useState<string | null>(null);
  const kind = getPreviewKind(props.filePath);
  const supported = kind !== null && !data.largeFile.largeMode;
  const toggle = useCallback((): void => {
    if (!supported) return;
    setContent((previous) =>
      previous !== null ? null : (buffer.viewRef.current?.state.doc.toString() ?? ""),
    );
    props.onCloseSearch();
  }, [buffer.viewRef, props, supported]);
  useScopedShortcut(
    "editor-toggle-preview",
    (event) => {
      event.preventDefault();
      toggle();
    },
    "editor",
    { enabled: supported },
  );
  return useMemo(
    () => ({
      content,
      isPreviewing: content !== null,
      kind,
      toggle: supported ? { active: content !== null, onToggle: toggle } : undefined,
    }),
    [content, kind, supported, toggle],
  );
}

export function useCodeMirrorEditorController(props: CodeMirrorEditorProps) {
  const data = useEditorFileData(props);
  const buffer = useEditorBuffer(props, data);
  const preview = useEditorPreview(props, data, buffer);
  const languageExtension = useMemo(
    () =>
      data.largeFile.largeMode
        ? null
        : getLanguageExtension(props.filePath, data.language.languageId),
    [data.language.languageId, data.largeFile.largeMode, props.filePath],
  );
  return {
    buffer,
    data,
    languageExtension,
    preview,
  };
}

export type CodeMirrorEditorController = ReturnType<typeof useCodeMirrorEditorController>;
