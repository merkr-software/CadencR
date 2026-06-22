import { useEffect, useRef, useCallback, useState, useMemo, lazy, Suspense } from "react";
import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { Loader2Icon } from "lucide-react";
import { useReadFile, useGetBlame, useGetFeatureWorkingDir } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useLsp } from "@/lib/lsp/useLsp";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { cn } from "@/lib/utils";
import { getPreviewKind } from "@/lib/file-language";
import { getLanguageExtension, getLanguageName } from "./language-extensions";
import { gitBlameExtension } from "./git-blame-extension";
import { useGitGutter } from "@/lib/editor/git-gutter/useGitGutter";
import { setGitGutterBaseline } from "@/lib/editor/git-gutter/git-gutter-extension";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";
import { EditorStatusBar } from "./EditorStatusBar";
import { useLargeFileMode } from "./useLargeFileMode";
import { useEditorSave } from "./useEditorSave";
import { useEditorFormat } from "./useEditorFormat";
import { LargeFileBanner } from "./LargeFileBanner";

// Lazy so the Markdown bundle only loads once the user toggles a preview.
const EditorPreviewSurface = lazy(() =>
  import("./EditorPreviewSurface").then((m) => ({ default: m.EditorPreviewSurface })),
);
import EditorSearchPanel from "./editor-search/EditorSearchPanel";
import { bufferSearchExtension } from "./editor-search/search-extension";
import { editorBufferKeymap } from "./editor-buffer-keymap";
import { EditorGoToLinePanel } from "./EditorGoToLinePanel";
import { EditorCommandsSlot } from "./lsp/EditorLspLayer";

interface CodeMirrorEditorProps {
  filePath: string;
  projectId: number;
  paneId: string;
  featureId: number;
  searchOpen: boolean;
  searchReopenSignal: number;
  /** Optional: when omitted the panel renders without a replace row. */
  searchReplaceMode?: boolean;
  searchReplaceFocusSignal?: number;
  /** Optional: pane-level toggle for the go-to-line overlay. */
  goToLineOpen?: boolean;
  goToLineReopenSignal?: number;
  onCloseSearch: () => void;
  onCloseGoToLine?: () => void;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

const AUTO_SAVE_DELAY_MS = 1500;

export function clampEditorLineNumber(lineNumber: number, lineCount: number): number {
  return Math.min(Math.max(1, lineNumber), Math.max(1, lineCount));
}

export function scrollToEditorLine(view: EditorView, lineNumber: number): void {
  const target = clampEditorLineNumber(lineNumber, view.state.doc.lines);
  const line = view.state.doc.line(target);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
}

const BUFFER_KEYMAP_EXT = editorBufferKeymap();
const BUFFER_SEARCH_EXT = bufferSearchExtension();

export default function CodeMirrorEditor({
  filePath,
  projectId,
  paneId,
  featureId,
  searchOpen,
  searchReopenSignal,
  searchReplaceMode = false,
  searchReplaceFocusSignal = 0,
  goToLineOpen = false,
  goToLineReopenSignal = 0,
  onCloseSearch,
  onCloseGoToLine,
  onEditorViewChange,
}: CodeMirrorEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const previewKind = getPreviewKind(filePath);

  const { value: vimModeSetting } = useDebouncedSetting("editor_vim_mode");
  const { value: autoSaveSetting } = useDebouncedSetting("editor_auto_save");
  const { value: gitBlameSetting } = useDebouncedSetting("editor_git_blame");
  const isVimEnabled = (vimModeSetting ?? "false") === "true";
  const isAutoSaveEnabled = (autoSaveSetting ?? "false") === "true";
  const isBlameEnabled = (gitBlameSetting ?? "false") === "true";
  const isAutoSaveEnabledRef = useRef(isAutoSaveEnabled);
  isAutoSaveEnabledRef.current = isAutoSaveEnabled;

  const blameCompartment = useRef(new Compartment());
  const lspCompartment = useRef(new Compartment());

  const { data, error } = useReadFile(
    { project_id: projectId, feature_id: featureId, file_path: filePath },
    {
      query: {
        enabled: Boolean(filePath && projectId),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  );

  // Very large files open read-only with language features off so CodeMirror
  // stays responsive. The backend `large` flag is authoritative.
  const { largeMode, editAnyway } = useLargeFileMode({
    large: data?.large,
    content: data?.content,
  });
  // Preview, syntax highlighting and editing are all disabled in large mode.
  const previewSupported = previewKind !== null && !largeMode;

  const cwdQuery = useGetFeatureWorkingDir(
    featureId,
    { project_id: projectId },
    { query: { enabled: Boolean(featureId && projectId), refetchOnWindowFocus: false } },
  );
  const workspaceRoot = cwdQuery.data?.path ?? undefined;
  const lsp = useLsp({
    workspaceRoot,
    filePath,
    projectId,
    featureId,
    paneId,
    enabled: !largeMode,
  });

  const { data: blameData } = useGetBlame(
    { project_id: projectId, feature_id: featureId, file_path: filePath },
    {
      query: {
        enabled: isBlameEnabled && !largeMode && Boolean(projectId && filePath),
        refetchOnWindowFocus: false,
      },
    },
  );

  // Git change-marker gutter — diffs the live buffer against HEAD using existing
  // git file-content data (frontend-only, no new backend route). Off in large
  // mode to keep multi-MB read-only buffers lightweight.
  const gitGutter = useGitGutter({ projectId, featureId, filePath, enabled: !largeMode });

  const setDirty = useEditorStore((s) => s.setDirty);
  const setCursorPosition = useEditorStore((s) => s.setCursorPosition);
  const clearPendingGoToLine = useEditorStore((s) => s.clearPendingGoToLine);
  const cursorPosition = useEditorStore(
    (s) =>
      s.features[featureId]?.panes[paneId]?.tabs.find((t) => t.filePath === filePath)
        ?.cursorPosition ?? { line: 1, col: 1 },
  );
  const pendingGoToLine = useEditorStore(
    (s) =>
      s.features[featureId]?.panes[paneId]?.tabs.find((t) => t.filePath === filePath)
        ?.pendingGoToLine,
  );

  const { beforeWrite } = useEditorFormat({
    projectId,
    featureId,
    filePath,
    viewRef,
    largeMode,
  });

  const { save, saveQuiet, autoSavedVisible } = useEditorSave({
    projectId,
    featureId,
    paneId,
    filePath,
    content: data?.content,
    viewRef,
    beforeWrite,
  });

  const handleSave = useCallback(() => {
    void save();
  }, [save]);

  const handleChange = useCallback(() => {
    // Read-only large mode never mutates the doc, so never arm auto-save.
    if (largeMode) return;
    setDirty(featureId, paneId, filePath, true);
    if (isAutoSaveEnabledRef.current) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => {
        void saveQuiet();
      }, AUTO_SAVE_DELAY_MS);
    }
  }, [largeMode, featureId, paneId, filePath, setDirty, saveQuiet]);

  const handleEditorViewChange = useCallback(
    (view: EditorView | null): void => {
      setEditorView(view);
      onEditorViewChange?.(paneId, view);
    },
    [onEditorViewChange, paneId],
  );

  const togglePreview = useCallback(() => {
    if (!previewSupported) return;
    // Editor is guaranteed mounted past the loader guard below.
    setPreviewContent((prev) =>
      prev !== null ? null : (viewRef.current?.state.doc.toString() ?? ""),
    );
    // Force-close the search panel so its `searchOpen` flag doesn't go stale
    // while the panel is hidden during preview.
    onCloseSearch();
  }, [previewSupported, onCloseSearch]);

  useScopedShortcut(
    "editor-toggle-preview",
    (e) => {
      e.preventDefault();
      togglePreview();
    },
    "editor",
    { enabled: previewSupported },
  );

  // Syntax highlighting is heavy on multi-MB files — skip it in large mode.
  const langExt = useMemo(
    () => (largeMode ? null : getLanguageExtension(filePath)),
    [largeMode, filePath],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ext = isBlameEnabled && blameData ? gitBlameExtension(blameData.lines) : [];
    view.dispatch({ effects: blameCompartment.current.reconfigure(ext) });
  }, [isBlameEnabled, blameData, data]);

  // Re-apply the LSP extension whenever it changes OR the editor view becomes
  // available. Depending on `editorView` (not just `lsp.extension`) closes a
  // race where the extension resolves before the view exists: without it the
  // plugin would never mount until the next extension change, which manifested
  // as "Cmd+Click does nothing until I reopen the file".
  useEffect(() => {
    if (!editorView) return;
    editorView.dispatch({ effects: lspCompartment.current.reconfigure(lsp.extension) });
  }, [lsp.extension, editorView]);

  // Feed the HEAD baseline into the git-gutter extension. Re-runs when the
  // baseline arrives/changes and once `data` flips so the editor is mounted.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setGitGutterBaseline.of(gitGutter.baseline) });
  }, [gitGutter.baseline, data]);

  const cursorExtension = useMemo(() => {
    return EditorView.updateListener.of((update) => {
      if (update.selectionSet) {
        const cursor = update.state.selection.main.head;
        const line = update.state.doc.lineAt(cursor);
        setCursorPosition(featureId, paneId, filePath, {
          line: line.number,
          col: cursor - line.from + 1,
        });
      }
    });
  }, [featureId, paneId, filePath, setCursorPosition]);

  useEffect(() => {
    registerSave(paneId, filePath, save);
    return () => unregisterSave(paneId, filePath);
  }, [paneId, filePath, save]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setDirty(featureId, paneId, filePath, false);
  }, [featureId, paneId, filePath, setDirty]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !data || pendingGoToLine == null) return;
    scrollToEditorLine(view, pendingGoToLine);
    clearPendingGoToLine(featureId, paneId, filePath);
  }, [data, pendingGoToLine, featureId, paneId, filePath, clearPendingGoToLine]);

  const isPreviewing = previewContent !== null;

  const previewToggle = useMemo(
    () => (previewSupported ? { active: isPreviewing, onToggle: togglePreview } : undefined),
    [previewSupported, isPreviewing, togglePreview],
  );

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-background text-destructive text-sm px-6 text-center">
        {error instanceof Error ? error.message : "Failed to load file"}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {largeMode && <LargeFileBanner onEditAnyway={editAnyway} />}
      <BaseCodeMirrorEditor
        initialContent={data.content}
        language={langExt}
        readOnly={largeMode}
        vimMode={isVimEnabled}
        ergonomics={!largeMode}
        onChange={handleChange}
        onSave={handleSave}
        extraExtensions={[
          cursorExtension,
          blameCompartment.current.of([]),
          lspCompartment.current.of([]),
          // Git gutter is static; large mode passes `enabled: false` to the
          // hook so its baseline stays `null` and no markers render.
          largeMode ? [] : gitGutter.extension,
          BUFFER_SEARCH_EXT,
          BUFFER_KEYMAP_EXT,
        ]}
        editorViewRef={viewRef}
        onEditorViewChange={handleEditorViewChange}
        className={cn("flex-1 overflow-auto", isPreviewing && "hidden")}
      />
      {isPreviewing && previewKind && (
        <Suspense fallback={null}>
          <EditorPreviewSurface
            kind={previewKind}
            content={previewContent ?? ""}
            filePath={filePath}
          />
        </Suspense>
      )}
      {searchOpen && editorView && !isPreviewing && (
        <EditorSearchPanel
          view={editorView}
          featureId={featureId}
          paneId={paneId}
          reopenSignal={searchReopenSignal}
          replaceMode={searchReplaceMode}
          replaceFocusSignal={searchReplaceFocusSignal}
          onClose={onCloseSearch}
        />
      )}
      {editorView && !largeMode && (
        <EditorCommandsSlot
          view={editorView}
          projectId={projectId}
          featureId={featureId}
          workspaceRoot={workspaceRoot ?? null}
        />
      )}
      {goToLineOpen && editorView && !searchOpen && onCloseGoToLine && (
        // Go-to-line and search share the top-right corner — render only
        // one at a time so they don't overlap. Search takes priority since
        // it's the more common action; opening go-to-line while find is
        // visible is intentionally a no-op until the user dismisses find.
        <EditorGoToLinePanel
          view={editorView}
          reopenSignal={goToLineReopenSignal}
          onClose={onCloseGoToLine}
        />
      )}
      <EditorStatusBar
        line={cursorPosition.line}
        col={cursorPosition.col}
        language={getLanguageName(filePath)}
        autoSavedVisible={autoSavedVisible}
        lspStatus={lsp.status}
        lspLanguageId={lsp.languageId}
        lspError={lsp.errorMessage}
        onLspRetry={lsp.onRetry}
        preview={previewToggle}
      />
    </div>
  );
}
