import { lazy, memo, Suspense } from "react";
import { Loader2Icon } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import BaseCodeMirrorEditor from "./BaseCodeMirrorEditor";
import { editorBufferKeymap } from "./editor-buffer-keymap";
import { EditorGoToLinePanel } from "./EditorGoToLinePanel";
import { EditorLanguageSelector } from "./EditorLanguageSelector";
import { EditorStatusBar } from "./EditorStatusBar";
import EditorSearchPanel from "./editor-search/EditorSearchPanel";
import { bufferSearchExtension } from "./editor-search/search-extension";
import { LargeFileBanner } from "./LargeFileBanner";
import { useLspSuggestion } from "./lsp/useLspSuggestion";
import { EditorCommandsSlot } from "./lsp/EditorLspLayer";
import {
  useCodeMirrorEditorController,
  type CodeMirrorEditorController,
  type CodeMirrorEditorProps,
} from "./useCodeMirrorEditorController";

const EditorPreviewSurface = lazy(() =>
  import("./EditorPreviewSurface").then((module) => ({ default: module.EditorPreviewSurface })),
);
const BUFFER_KEYMAP_EXT = editorBufferKeymap();
const BUFFER_SEARCH_EXT = bufferSearchExtension();

function CodeMirrorEditor(props: CodeMirrorEditorProps) {
  const controller = useCodeMirrorEditorController(props);
  useLspSuggestion(props.projectId, controller.data.lsp.resolution);
  if (controller.data.fileQuery.error && !controller.data.fileQuery.data) {
    return (
      <div className="h-full flex items-center justify-center bg-background text-destructive text-sm px-6 text-center">
        {apiErrorMessage(controller.data.fileQuery.error, "Failed to load file")}
      </div>
    );
  }
  if (!controller.data.fileQuery.data) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <CodeMirrorEditorContent props={props} controller={controller} />;
}

function CodeMirrorEditorContent({
  props,
  controller,
}: {
  props: CodeMirrorEditorProps;
  controller: CodeMirrorEditorController;
}) {
  const { buffer, data, preview } = controller;
  return (
    <div className="h-full flex flex-col">
      {data.largeFile.largeMode && <LargeFileBanner onEditAnyway={data.largeFile.editAnyway} />}
      <BaseCodeMirrorEditor
        initialContent={data.fileQuery.data?.content ?? ""}
        language={controller.languageExtension}
        readOnly={data.largeFile.largeMode}
        vimMode={data.isVimEnabled}
        ergonomics={!data.largeFile.largeMode}
        onDocChange={buffer.handleChange}
        onSave={buffer.handleSave}
        extraExtensions={[
          buffer.cursorExtension,
          buffer.blameCompartment.current.of([]),
          buffer.lspCompartment.current.of([]),
          data.largeFile.largeMode ? [] : data.gitGutter.extension,
          BUFFER_SEARCH_EXT,
          BUFFER_KEYMAP_EXT,
        ]}
        editorViewRef={buffer.viewRef}
        onEditorViewChange={buffer.handleEditorViewChange}
        className={cn("flex-1 overflow-auto", preview.isPreviewing && "hidden")}
      />
      <EditorOverlays props={props} controller={controller} />
      <EditorStatusBar
        line={buffer.cursorPosition.line}
        col={buffer.cursorPosition.col}
        language={<EditorLanguageSelector filePath={props.filePath} language={data.language} />}
        autoSavedVisible={buffer.autoSavedVisible}
        diskSync={buffer.saveState}
        isFormatting={buffer.isFormatting}
        readError={
          data.fileQuery.error
            ? apiErrorMessage(data.fileQuery.error, "Failed to check disk")
            : undefined
        }
        lspStatus={data.lsp.status}
        lspLanguageId={data.lsp.languageId}
        lspError={data.lsp.errorMessage}
        onLspRetry={data.lsp.onRetry}
        preview={preview.toggle}
      />
    </div>
  );
}

function EditorOverlays({
  props,
  controller,
}: {
  props: CodeMirrorEditorProps;
  controller: CodeMirrorEditorController;
}) {
  const { buffer, data, preview } = controller;
  return (
    <>
      {preview.isPreviewing && preview.kind && (
        <Suspense fallback={null}>
          <EditorPreviewSurface
            kind={preview.kind}
            content={preview.content ?? ""}
            filePath={props.filePath}
            projectId={props.projectId}
            featureId={props.featureId}
          />
        </Suspense>
      )}
      {(props.searchOpen ?? false) && buffer.editorView && !preview.isPreviewing && (
        <EditorSearchPanel
          view={buffer.editorView}
          featureId={props.featureId}
          paneId={props.paneId}
          reopenSignal={props.searchReopenSignal}
          replaceMode={props.searchReplaceMode ?? false}
          replaceFocusSignal={props.searchReplaceFocusSignal ?? 0}
          onClose={props.onCloseSearch}
        />
      )}
      {buffer.editorView && !data.largeFile.largeMode && (
        <EditorCommandsSlot
          view={buffer.editorView}
          projectId={props.projectId}
          featureId={props.featureId}
          workspaceRoot={data.workspaceRoot ?? null}
        />
      )}
      {(props.goToLineOpen ?? false) &&
        buffer.editorView &&
        !props.searchOpen &&
        props.onCloseGoToLine && (
          <EditorGoToLinePanel
            view={buffer.editorView}
            reopenSignal={props.goToLineReopenSignal ?? 0}
            onClose={props.onCloseGoToLine}
          />
        )}
    </>
  );
}

export default memo(CodeMirrorEditor);
