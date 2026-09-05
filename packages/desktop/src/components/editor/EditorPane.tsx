import type { EditorView } from "@codemirror/view";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useEditorStore, isUntitledPath } from "@/stores/editor-store";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { isExcalidrawFile, isImageFile } from "@/lib/file-language";
import EditorSubTabs from "./EditorSubTabs";
import { copyFilePath } from "./copyFilePath";
import { clearPaneSearch } from "./editor-search/search-cache";
import { useActiveConflict } from "./useAutoConflictResolution";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import NeovimMobileFallback from "./neovim/NeovimMobileFallback";

const CodeMirrorEditor = lazy(() => import("./CodeMirrorEditor"));
const ConflictResolverEditor = lazy(() => import("./ConflictResolverEditor"));
const UntitledCodeMirrorEditor = lazy(() => import("./UntitledCodeMirrorEditor"));
const ImageFileViewer = lazy(() => import("./ImageFileViewer"));
const ExcalidrawEditor = lazy(() => import("./ExcalidrawEditor"));
const NeovimPane = lazy(() => import("./neovim/NeovimPane"));

interface EditorPaneProps {
  featureId: number;
  paneId: string;
  projectId: number;
  isActive?: boolean;
  onEditorViewChange?: (paneId: string, view: EditorView | null) => void;
}

function useEditorFileShortcut({
  action,
  activeFilePath,
  id,
  isFocusedPane,
}: {
  action: () => void;
  activeFilePath: string | null;
  id: "editor-buffer-search" | "editor-replace" | "editor-go-to-line";
  isFocusedPane: boolean;
}): void {
  useScopedGlobalShortcutById(
    id,
    (event) => {
      if (!isFocusedPane || !activeFilePath) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    },
    "editor",
    { enabled: isFocusedPane && Boolean(activeFilePath) },
  );
}

function useEditorPaneShortcuts({
  activeFilePath,
  featureId,
  isFocusedPane,
  openGoToLine,
  openSearch,
  openUntitledBuffer,
  paneId,
}: {
  activeFilePath: string | null;
  featureId: number;
  isFocusedPane: boolean;
  openGoToLine: () => void;
  openSearch: (withReplace: boolean) => void;
  openUntitledBuffer: ReturnType<typeof useEditorStore.getState>["openUntitledBuffer"];
  paneId: string;
}): void {
  useEditorFileShortcut({
    action: () => openSearch(false),
    activeFilePath,
    id: "editor-buffer-search",
    isFocusedPane,
  });
  useEditorFileShortcut({
    action: () => openSearch(true),
    activeFilePath,
    id: "editor-replace",
    isFocusedPane,
  });
  useEditorFileShortcut({
    action: openGoToLine,
    activeFilePath,
    id: "editor-go-to-line",
    isFocusedPane,
  });
  useScopedGlobalShortcutById(
    "editor-new",
    (event) => {
      if (!isFocusedPane) return;
      event.preventDefault();
      event.stopPropagation();
      openUntitledBuffer(featureId, paneId);
    },
    "editor",
    { enabled: isFocusedPane },
  );
  useScopedGlobalShortcutById(
    "editor-copy-path",
    (event) => {
      if (!isFocusedPane) return;
      event.preventDefault();
      event.stopPropagation();
      copyFilePath(activeFilePath);
    },
    "editor",
    { enabled: isFocusedPane },
  );
}

function useEditorPaneControls({
  activeFilePath,
  featureId,
  isFocusedPane,
  openUntitledBuffer,
  paneId,
}: {
  activeFilePath: string | null;
  featureId: number;
  isFocusedPane: boolean;
  openUntitledBuffer: ReturnType<typeof useEditorStore.getState>["openUntitledBuffer"];
  paneId: string;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchReopenSignal, setSearchReopenSignal] = useState(0);
  const [replaceMode, setReplaceMode] = useState(false);
  const [replaceFocusSignal, setReplaceFocusSignal] = useState(0);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineReopenSignal, setGoToLineReopenSignal] = useState(0);
  const openSearch = useCallback((withReplace: boolean): void => {
    setSearchOpen((wasOpen) => {
      if (wasOpen) setSearchReopenSignal((value) => value + 1);
      return true;
    });
    if (withReplace) {
      setReplaceMode(true);
      setReplaceFocusSignal((value) => value + 1);
    }
  }, []);
  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setReplaceMode(false);
  }, []);
  const openGoToLine = useCallback((): void => {
    setGoToLineOpen((wasOpen) => {
      if (wasOpen) setGoToLineReopenSignal((value) => value + 1);
      return true;
    });
  }, []);
  const closeGoToLine = useCallback((): void => setGoToLineOpen(false), []);
  useEditorPaneShortcuts({
    activeFilePath,
    featureId,
    isFocusedPane,
    openGoToLine,
    openSearch,
    openUntitledBuffer,
    paneId,
  });
  useEffect(() => () => clearPaneSearch(featureId, paneId), [featureId, paneId]);
  return useMemo(
    () => ({
      closeGoToLine,
      closeSearch,
      goToLineOpen,
      goToLineReopenSignal,
      replaceFocusSignal,
      replaceMode,
      searchOpen,
      searchReopenSignal,
    }),
    [
      closeGoToLine,
      closeSearch,
      goToLineOpen,
      goToLineReopenSignal,
      replaceFocusSignal,
      replaceMode,
      searchOpen,
      searchReopenSignal,
    ],
  );
}

export default function EditorPane({
  featureId,
  paneId,
  projectId,
  isActive,
  onEditorViewChange,
}: EditorPaneProps) {
  const activeFilePath = useEditorStore(
    (s) => s.features[featureId]?.panes[paneId]?.activeFilePath ?? null,
  );
  const activePaneId = useEditorStore((s) => s.features[featureId]?.activePaneId);
  const activeFileIsDirty = useEditorStore(
    (s) =>
      s.features[featureId]?.panes[paneId]?.tabs.find((tab) => tab.filePath === activeFilePath)
        ?.isDirty ?? false,
  );
  const activeConflict = useActiveConflict(activeFilePath, activeFileIsDirty);
  const setActivePane = useEditorStore((s) => s.setActivePane);
  const openUntitledBuffer = useEditorStore((s) => s.openUntitledBuffer);
  const isFocusedPane = activePaneId === paneId;
  const controls = useEditorPaneControls({
    activeFilePath,
    featureId,
    isFocusedPane,
    openUntitledBuffer,
    paneId,
  });
  const vimModeLevel = useVimModeLevel();
  const isMobile = useIsMobile();
  const isFullNeovim = vimModeLevel === "2" && !isMobile;
  return (
    <div
      className="flex flex-col h-full"
      onFocus={() => {
        if (!isActive) setActivePane(featureId, paneId);
      }}
    >
      {isFullNeovim ? (
        <Suspense fallback={suspenseFallback}>
          <NeovimPane featureId={featureId} />
        </Suspense>
      ) : (
        <>
          {vimModeLevel === "2" && isMobile && <NeovimMobileFallback />}
          <EditorSubTabs featureId={featureId} paneId={paneId} projectId={projectId} />
          <div className="flex-1 overflow-hidden">
            {activeFilePath ? (
              <EditorPaneContent
                activeConflict={activeConflict}
                activeFilePath={activeFilePath}
                controls={controls}
                featureId={featureId}
                onEditorViewChange={onEditorViewChange}
                paneId={paneId}
                projectId={projectId}
              />
            ) : (
              <div className="flex items-center justify-center h-full px-4 text-muted-foreground text-sm text-center text-balance">
                Open a file from the sidebar, press CMD+N for a new buffer, or use CMD+P
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const suspenseFallback = (
  <div className="flex flex-col gap-2 p-4 animate-pulse">
    <div className="h-4 w-3/4 rounded bg-muted" />
    <div className="h-4 w-1/2 rounded bg-muted" />
    <div className="h-4 w-5/6 rounded bg-muted" />
  </div>
);

function EditorPaneContent({
  activeConflict,
  activeFilePath,
  controls,
  featureId,
  onEditorViewChange,
  paneId,
  projectId,
}: {
  activeConflict: ReturnType<typeof useActiveConflict>;
  activeFilePath: string;
  controls: ReturnType<typeof useEditorPaneControls>;
  featureId: number;
  onEditorViewChange: EditorPaneProps["onEditorViewChange"];
  paneId: string;
  projectId: number;
}) {
  return (
    <Suspense fallback={suspenseFallback}>
      {activeConflict ? (
        <ConflictResolverEditor
          key={`conflict:${activeFilePath}`}
          filePath={activeFilePath}
          conflictKind={activeConflict.kind}
          projectId={projectId}
          paneId={paneId}
          featureId={featureId}
          onEditorViewChange={onEditorViewChange}
        />
      ) : isExcalidrawFile(activeFilePath) ? (
        <ExcalidrawEditor
          key={activeFilePath}
          filePath={activeFilePath}
          projectId={projectId}
          featureId={featureId}
          paneId={paneId}
        />
      ) : isImageFile(activeFilePath) ? (
        <ImageFileViewer
          key={activeFilePath}
          filePath={activeFilePath}
          projectId={projectId}
          featureId={featureId}
        />
      ) : isUntitledPath(activeFilePath) ? (
        <UntitledCodeMirrorEditor
          key={activeFilePath}
          filePath={activeFilePath}
          projectId={projectId}
          paneId={paneId}
          featureId={featureId}
          onEditorViewChange={onEditorViewChange}
        />
      ) : (
        <CodeMirrorEditor
          key={activeFilePath}
          filePath={activeFilePath}
          projectId={projectId}
          paneId={paneId}
          featureId={featureId}
          searchOpen={controls.searchOpen}
          searchReopenSignal={controls.searchReopenSignal}
          searchReplaceMode={controls.replaceMode}
          searchReplaceFocusSignal={controls.replaceFocusSignal}
          goToLineOpen={controls.goToLineOpen}
          goToLineReopenSignal={controls.goToLineReopenSignal}
          onCloseSearch={controls.closeSearch}
          onCloseGoToLine={controls.closeGoToLine}
          onEditorViewChange={onEditorViewChange}
        />
      )}
    </Suspense>
  );
}
