import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import type { EditorView } from "@codemirror/view";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { Extension, Text } from "@codemirror/state";
import { Loader2Icon } from "lucide-react";
import type { GitOperationKind } from "@/api/generated";
import { useSetting } from "@/hooks/useSetting";
import { useEditorLanguage } from "@/hooks/useEditorLanguage";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";
import { EditorDiskSyncIndicator, type EditorDiskSyncState } from "./EditorDiskSyncIndicator";
import { getLanguageExtension } from "./language-extensions";
import { registerSave, unregisterSave } from "./editorSaveRegistry";
import { useEditorFormat } from "./useEditorFormat";
import { useEditorSave } from "./useEditorSave";
import { conflictResolutionControls } from "./conflict-resolution-extension";
import {
  applyConflictChoice,
  buildConflictHunks,
  type ConflictChoice,
  type MappedConflictHunk,
} from "./conflict-resolution-adapter";
const AUTO_SAVE_DELAY_MS = 1500;

interface ConflictResultResolverProps {
  featureId: number;
  paneId: string;
  projectId: number;
  filePath: string;
  initialContent: string;
  operation: GitOperationKind | null;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

export default function ConflictResultResolver(props: ConflictResultResolverProps): ReactElement {
  const editor = useConflictResultEditor(props);
  const labels = useMemo(() => conflictSourceLabels(props.operation), [props.operation]);
  const extraExtensions = useMemo<Extension[]>(
    () => [
      conflictResolutionControls({
        hunks: editor.hunks,
        currentLabel: labels.current,
        incomingLabel: labels.incoming,
        onApply: editor.onApply,
      }),
      CodeMirrorView.contentAttributes.of({ "aria-label": "Writable Result" }),
      resultEditorTheme,
    ],
    [editor.hunks, editor.onApply, labels.current, labels.incoming],
  );
  // One writable Result view, edited like any file. The conflict regions and
  // per-hunk actions live inline in CodeMirror — no toolbar, header, or footer.
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden" aria-label="Writable Result">
        <BaseCodeMirrorEditor
          initialContent={props.initialContent}
          language={editor.languageExtension}
          vimMode={editor.vimEnabled}
          editorViewRef={editor.viewRef}
          onDocChange={editor.onChange}
          onSave={editor.onSave}
          onEditorViewChange={editor.onViewChange}
          extraExtensions={extraExtensions}
          className="h-full overflow-hidden"
        />
      </div>
      <ConflictEditorStatus sync={editor.diskSync} isFormatting={editor.isFormatting} />
      <p className="sr-only" aria-live="polite">
        {editor.announcement}
      </p>
    </div>
  );
}

function ConflictEditorStatus({
  sync,
  isFormatting,
}: {
  sync: EditorDiskSyncState;
  isFormatting: boolean;
}): ReactElement | null {
  const { isSaving, errorMessage } = sync;
  if (!isSaving && !isFormatting && !errorMessage && !sync.diskChanged) return null;
  return (
    <div className="absolute bottom-2 right-3 z-10 flex items-center gap-1.5 rounded border border-border bg-popover px-2 py-1 text-xs shadow-md">
      <EditorDiskSyncIndicator sync={sync} />
      {(isSaving || isFormatting) && <Loader2Icon className="size-3 animate-spin" aria-hidden />}
      {(errorMessage || isSaving || isFormatting) && (
        <span
          role={errorMessage ? "alert" : "status"}
          className={errorMessage ? "text-destructive" : "text-muted-foreground"}
        >
          {errorMessage ?? (isFormatting ? "Formatting…" : "Saving…")}
        </span>
      )}
    </div>
  );
}

function useConflictResultEditor({
  featureId,
  paneId,
  projectId,
  filePath,
  initialContent,
  onEditorViewChange,
}: ConflictResultResolverProps) {
  const viewRef = useRef<EditorView | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapping = useConflictHunkMappings({
    paneId,
    initialContent,
    viewRef,
    onEditorViewChange,
  });
  const language = useEditorLanguage(projectId, filePath);
  const { value: vimSetting } = useSetting("editor_vim_mode");
  const { value: autoSaveSetting } = useSetting("editor_auto_save");
  const { beforeWrite, isFormatting } = useEditorFormat({
    projectId,
    featureId,
    filePath,
    viewRef,
    largeMode: false,
  });
  const saveState = useEditorSave({
    projectId,
    featureId,
    paneId,
    filePath,
    content: initialContent,
    viewRef,
    beforeWrite,
  });
  const autoSaveEnabledRef = useRef((autoSaveSetting ?? "false") === "true");
  autoSaveEnabledRef.current = (autoSaveSetting ?? "false") === "true";

  const onChange = useCallback(
    (doc: Text): void => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (!saveState.onDocChange(doc) || !autoSaveEnabledRef.current) return;
      autoSaveTimerRef.current = setTimeout(() => void saveState.saveQuiet(), AUTO_SAVE_DELAY_MS);
    },
    [saveState.onDocChange, saveState.saveQuiet],
  );
  const onSave = useCallback((): void => {
    void saveState.save();
  }, [saveState.save]);
  const languageExtension = useMemo(
    () => getLanguageExtension(filePath, language.languageId),
    [filePath, language.languageId],
  );

  useConflictSaveRegistration(paneId, filePath, saveState.saveForClose, autoSaveTimerRef);

  return useMemo(
    () => ({
      viewRef,
      hunks: mapping.hunks,
      onApply: mapping.onApply,
      onChange,
      onSave,
      onViewChange: mapping.onViewChange,
      announcement: mapping.announcement,
      diskSync: saveState,
      isFormatting,
      vimEnabled: (vimSetting ?? "false") === "true",
      languageExtension,
    }),
    [languageExtension, mapping, onChange, onSave, saveState, isFormatting, vimSetting],
  );
}

function useConflictSaveRegistration(
  paneId: string,
  filePath: string,
  save: () => Promise<void>,
  autoSaveTimerRef: RefObject<ReturnType<typeof setTimeout> | null>,
): void {
  useEffect(() => {
    registerSave(paneId, filePath, save);
    return () => unregisterSave(paneId, filePath);
  }, [filePath, paneId, save]);
  useEffect(
    () => () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    },
    [autoSaveTimerRef],
  );
}

function useConflictHunkMappings({
  paneId,
  initialContent,
  viewRef,
  onEditorViewChange,
}: Pick<ConflictResultResolverProps, "paneId" | "initialContent" | "onEditorViewChange"> & {
  viewRef: RefObject<EditorView | null>;
}) {
  const hunks = useMemo(() => buildConflictHunks(initialContent), [initialContent]);
  const [announcement, setAnnouncement] = useState("");
  const onApply = useCallback(
    (hunk: MappedConflictHunk, choice: ConflictChoice): void => {
      const applied = viewRef.current ? applyConflictChoice(viewRef.current, hunk, choice) : false;
      setAnnouncement(
        applied
          ? `Applied ${choice} to the selected conflict hunk.`
          : "The hunk changed and could not be applied safely.",
      );
    },
    [viewRef],
  );
  const onViewChange = useCallback(
    (view: EditorView | null): void => onEditorViewChange?.(paneId, view),
    [onEditorViewChange, paneId],
  );
  return useMemo(
    () => ({
      hunks,
      onApply,
      onViewChange,
      announcement,
    }),
    [announcement, hunks, onApply, onViewChange],
  );
}

function conflictSourceLabels(operation: GitOperationKind | null): {
  current: string;
  incoming: string;
} {
  if (operation === "merge") {
    return { current: "Current branch", incoming: "Incoming branch" };
  }
  if (operation === "rebase") {
    return { current: "Rebased result", incoming: "Replayed commit" };
  }
  return { current: "Index stage 2", incoming: "Index stage 3" };
}

const resultEditorTheme = CodeMirrorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});
