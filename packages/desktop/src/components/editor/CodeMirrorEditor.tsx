import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { useReadFile, useWriteFile, useGetBlame } from "@/api/generated";
import { useEditorStore } from "@/stores/editor-store";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { getLanguageExtension } from "./language-extensions";
import { gitBlameExtension } from "./git-blame-extension";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";
import { toast } from "sonner";

interface CodeMirrorEditorProps {
  filePath: string;
  projectId: number;
  paneId: string;
  featureId: number;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

const AUTO_SAVE_DELAY_MS = 1500;

export function clampEditorLineNumber(lineNumber: number, lineCount: number): number {
  return Math.min(Math.max(1, lineNumber), Math.max(1, lineCount));
}

function getLanguageName(filePath: string): string {
  const ext = filePath.split(".").at(-1)?.toLowerCase() ?? "";
  const MAP: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TSX",
    js: "JavaScript",
    jsx: "JSX",
    json: "JSON",
    html: "HTML",
    css: "CSS",
    rs: "Rust",
    md: "Markdown",
    mdx: "MDX",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    py: "Python",
    go: "Go",
    sql: "SQL",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
  };
  return MAP[ext] ?? "Plain Text";
}

export default function CodeMirrorEditor({
  filePath,
  projectId,
  paneId,
  featureId,
  onEditorViewChange,
}: CodeMirrorEditorProps) {
  const viewRef = useRef<EditorView | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoSavedVisible, setAutoSavedVisible] = useState(false);
  const autoSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutateAsyncRef = useRef<ReturnType<typeof useWriteFile>["mutateAsync"] | null>(null);

  const { value: vimModeSetting } = useDebouncedSetting("editor_vim_mode");
  const { value: autoSaveSetting } = useDebouncedSetting("editor_auto_save");
  const { value: gitBlameSetting } = useDebouncedSetting("editor_git_blame");
  const isVimEnabled = (vimModeSetting ?? "false") === "true";
  const isAutoSaveEnabled = (autoSaveSetting ?? "false") === "true";
  const isBlameEnabled = (gitBlameSetting ?? "false") === "true";
  const isAutoSaveEnabledRef = useRef(isAutoSaveEnabled);
  isAutoSaveEnabledRef.current = isAutoSaveEnabled;

  const blameCompartment = useRef(new Compartment());
  const { data: blameData } = useGetBlame(
    { project_id: projectId, feature_id: featureId, file_path: filePath },
    {
      query: {
        enabled: isBlameEnabled && Boolean(projectId && filePath),
        refetchOnWindowFocus: false,
      },
    },
  );

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

  const { data, isLoading, error } = useReadFile(
    { project_id: projectId, feature_id: featureId, file_path: filePath },
    {
      query: {
        enabled: Boolean(filePath && projectId),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  );

  const writeFile = useWriteFile();
  mutateAsyncRef.current = writeFile.mutateAsync;

  const saveQuiet = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !mutateAsyncRef.current) return;
    const content = view.state.doc.toString();
    try {
      await mutateAsyncRef.current({
        data: {
          project_id: projectId,
          feature_id: featureId,
          file_path: filePath,
          content,
        },
      });
      setDirty(featureId, paneId, filePath, false);
      setAutoSavedVisible(true);
      if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
      autoSavedTimerRef.current = setTimeout(() => setAutoSavedVisible(false), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to auto-save file";
      toast.error(msg);
    }
  }, [projectId, filePath, featureId, paneId, setDirty]);

  const save = useCallback(async () => {
    const view = viewRef.current;
    if (!view || !mutateAsyncRef.current) return;
    const content = view.state.doc.toString();
    try {
      await mutateAsyncRef.current({
        data: {
          project_id: projectId,
          feature_id: featureId,
          file_path: filePath,
          content,
        },
      });
      setDirty(featureId, paneId, filePath, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save file";
      toast.error(msg);
    }
  }, [projectId, filePath, featureId, paneId, setDirty]);

  const handleSave = useCallback(() => {
    void save();
  }, [save]);

  const handleChange = useCallback(() => {
    setDirty(featureId, paneId, filePath, true);
    if (isAutoSaveEnabledRef.current) {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => {
        void saveQuiet();
      }, AUTO_SAVE_DELAY_MS);
    }
  }, [featureId, paneId, filePath, setDirty, saveQuiet]);

  const handleEditorViewChange = useCallback(
    (view: EditorView | null): void => {
      onEditorViewChange?.(paneId, view);
    },
    [onEditorViewChange, paneId],
  );

  const langExt = useMemo(() => getLanguageExtension(filePath), [filePath]);

  // Hot-swap blame extension when data or setting changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const ext = isBlameEnabled && blameData ? gitBlameExtension(blameData.lines) : [];
    view.dispatch({ effects: blameCompartment.current.reconfigure(ext) });
  }, [isBlameEnabled, blameData]);

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

  // Register save callback for external callers
  useEffect(() => {
    registerSave(paneId, filePath, save);
    return () => unregisterSave(paneId, filePath);
  }, [paneId, filePath, save]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
    };
  }, []);

  // Update editor content when data loads
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !data) return;

    const currentContent = view.state.doc.toString();
    if (currentContent !== data.content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: data.content },
      });
      setDirty(featureId, paneId, filePath, false);
    }
  }, [data, filePath, featureId, paneId, setDirty]);

  // Scroll to pending go-to line after content is loaded
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !data || pendingGoToLine == null) return;

    const lineCount = view.state.doc.lines;
    const targetLine = clampEditorLineNumber(pendingGoToLine, lineCount);
    const line = view.state.doc.line(targetLine);

    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });

    clearPendingGoToLine(featureId, paneId, filePath);
  }, [data, pendingGoToLine, featureId, paneId, filePath, clearPendingGoToLine]);

  const overlay = isLoading ? (
    <div className="absolute inset-0 flex flex-col gap-2 p-4 animate-pulse z-10 bg-background">
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="h-4 w-1/2 rounded bg-muted" />
      <div className="h-4 w-5/6 rounded bg-muted" />
      <div className="h-4 w-2/3 rounded bg-muted" />
    </div>
  ) : error ? (
    <div className="absolute inset-0 flex items-center justify-center z-10 bg-background text-destructive text-sm px-6 text-center">
      {error instanceof Error ? error.message : "Failed to load file"}
    </div>
  ) : null;

  return (
    <div className="h-full flex flex-col relative">
      {overlay}
      <BaseCodeMirrorEditor
        language={langExt}
        vimMode={isVimEnabled}
        onChange={handleChange}
        onSave={handleSave}
        extraExtensions={[cursorExtension, blameCompartment.current.of([])]}
        editorViewRef={viewRef}
        onEditorViewChange={handleEditorViewChange}
        className="flex-1 overflow-auto"
      />
      <StatusBar
        line={cursorPosition.line}
        col={cursorPosition.col}
        language={getLanguageName(filePath)}
        autoSavedVisible={autoSavedVisible}
      />
    </div>
  );
}

interface StatusBarProps {
  line: number;
  col: number;
  language: string;
  autoSavedVisible: boolean;
}

function StatusBar({ line, col, language, autoSavedVisible }: StatusBarProps) {
  return (
    <div className="flex items-center justify-between px-3 py-0.5 border-t border-border bg-card text-xs text-muted-foreground shrink-0">
      <span>
        Ln {line}, Col {col}
      </span>
      <div className="flex items-center gap-3">
        {autoSavedVisible && <span>Auto-saved</span>}
        <span>{language}</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
}
