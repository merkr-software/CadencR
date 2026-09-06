import {
  memo,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { EditorView } from "@codemirror/view";
import { useScopedGlobalShortcutById, useScopedShortcut } from "@/hooks/useShortcut";
import { isInCodeMirrorEditor } from "@/lib/shortcuts/dom-targets";
import { useEditorState } from "@/hooks/useEditorState";
import { useEditorStore } from "@/stores/editor-store";
import { useFeatureLayoutContext } from "@/components/feature-layout/FeatureLayoutContext";
import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { GitBranch, PanelLeft, Search } from "lucide-react";
import { useFeatureWorktreePath } from "@/hooks/useFeatureWorktreePath";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { KbdShortcut } from "@/components/KbdShortcut";
import { EditorSidebarLayout } from "./EditorSidebarLayout";
import EditorSplitTree from "./EditorSplitTree";
import FileTree from "./FileTree";
import FileSearchDialog from "./FileSearchDialog";
import { saveAll } from "./editorSaveRegistry";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import {
  ConfirmedConflictPathsProvider,
  useConfirmedConflictPaths,
} from "./useAutoConflictResolution";
import { EditorLeaveDialog } from "./EditorLeaveDialog";
import { focusNeovimEditor } from "./neovim/focusNeovimEditor";

interface FeatureEditorTabProps {
  featureId: number;
  projectId: number;
  projectPath: string;
  focusedOverride?: boolean;
}

export interface FeatureEditorTabHandle {
  /** Call before leaving the editor tab. Calls `proceed` if allowed. */
  requestLeave: (proceed: () => void) => void;
  focusActiveEditor: () => void;
}

const EDITOR_SIDEBAR_COLLAPSED_SETTING = "editor_sidebar_collapsed";

function useEditorFocusState(featureId: number, activePaneId: string, isEditorFocused: boolean) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorViewsRef = useRef<Map<string, EditorView>>(new Map());
  const focusActiveEditor = useCallback((): void => {
    const editor = editorViewsRef.current.get(activePaneId);
    if (editor) editor.focus();
    else focusNeovimEditor(featureId);
  }, [activePaneId, featureId]);
  const shouldRestoreEditorFocus = useCallback((): boolean => {
    const active = document.activeElement;
    return !(active instanceof HTMLElement && rootRef.current?.contains(active));
  }, []);
  const handleEditorViewChange = useCallback(
    (paneId: string, view: EditorView | null): void => {
      if (!view) {
        editorViewsRef.current.delete(paneId);
        return;
      }
      editorViewsRef.current.set(paneId, view);
      if (isEditorFocused && paneId === activePaneId && shouldRestoreEditorFocus()) {
        requestAnimationFrame(() => view.focus());
      }
    },
    [activePaneId, isEditorFocused, shouldRestoreEditorFocus],
  );
  return useMemo(
    () => ({ focusActiveEditor, handleEditorViewChange, rootRef, shouldRestoreEditorFocus }),
    [focusActiveEditor, handleEditorViewChange, shouldRestoreEditorFocus],
  );
}

type EditorFocusState = ReturnType<typeof useEditorFocusState>;

function useEditorLeaveGuard(
  ref: React.ForwardedRef<FeatureEditorTabHandle>,
  panes: ReturnType<typeof useEditorState>["panes"],
  focus: EditorFocusState,
) {
  const [open, setOpen] = useState(false);
  const [pendingProceed, setPendingProceed] = useState<(() => void) | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const getDirtyTabs = useCallback(
    () =>
      Object.entries(panes).flatMap(([paneId, pane]) =>
        pane.tabs.filter((tab) => tab.isDirty).map((tab) => ({ paneId, filePath: tab.filePath })),
      ),
    [panes],
  );
  useImperativeHandle(
    ref,
    () => ({
      requestLeave(proceed) {
        if (getDirtyTabs().length === 0) proceed();
        else {
          setPendingProceed(() => proceed);
          setOpen(true);
        }
      },
      focusActiveEditor: focus.focusActiveEditor,
    }),
    [focus.focusActiveEditor, getDirtyTabs],
  );
  const cancel = useCallback(() => {
    setOpen(false);
    setPendingProceed(null);
  }, []);
  const switchWithoutSaving = useCallback(() => {
    setOpen(false);
    pendingProceed?.();
    setPendingProceed(null);
  }, [pendingProceed]);
  const saveAndSwitch = useCallback(async () => {
    setIsSaving(true);
    try {
      await saveAll(getDirtyTabs());
      setOpen(false);
      pendingProceed?.();
      setPendingProceed(null);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to save files"));
    } finally {
      setIsSaving(false);
    }
  }, [getDirtyTabs, pendingProceed]);
  return useMemo(
    () => ({
      cancel,
      dirtyCount: getDirtyTabs().length,
      isSaving,
      open,
      saveAndSwitch,
      switchWithoutSaving,
    }),
    [cancel, getDirtyTabs, isSaving, open, saveAndSwitch, switchWithoutSaving],
  );
}

type EditorLeaveGuard = ReturnType<typeof useEditorLeaveGuard>;

function useEditorNavigationShortcuts({
  featureId,
  handleToggleSidebar,
  isEditorFocused,
  navigatePane,
}: {
  featureId: number;
  handleToggleSidebar: () => void;
  isEditorFocused: boolean;
  navigatePane: ReturnType<typeof useEditorStore.getState>["navigatePane"];
}): void {
  useScopedGlobalShortcutById(
    "editor-toggle-sidebar",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) handleToggleSidebar();
    },
    "editor",
    { enabled: isEditorFocused },
  );
  const usePaneShortcut = (
    id:
      | "editor-nav-pane-left"
      | "editor-nav-pane-right"
      | "editor-nav-pane-up"
      | "editor-nav-pane-down",
    direction: "left" | "right" | "up" | "down",
  ): void => {
    useScopedShortcut(
      id,
      (event) => {
        if ((direction === "up" || direction === "down") && isInCodeMirrorEditor(event.target))
          return;
        event.preventDefault();
        navigatePane(featureId, direction);
      },
      "editor",
      { enabled: isEditorFocused },
    );
  };
  usePaneShortcut("editor-nav-pane-left", "left");
  usePaneShortcut("editor-nav-pane-right", "right");
  usePaneShortcut("editor-nav-pane-up", "up");
  usePaneShortcut("editor-nav-pane-down", "down");
}

function useFeatureEditorEffects({
  focus,
  initFeature,
  isEditorFocused,
  persistedCollapsed,
  sidebarVisible,
  toggleSidebar,
}: {
  focus: EditorFocusState;
  initFeature: () => void;
  isEditorFocused: boolean;
  persistedCollapsed: string | null;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
}): void {
  const initializedRef = useRef(false);
  useEffect(() => initFeature(), [initFeature]);
  useEffect(() => {
    if (!isEditorFocused || !focus.shouldRestoreEditorFocus()) return undefined;
    const frame = requestAnimationFrame(focus.focusActiveEditor);
    return () => cancelAnimationFrame(frame);
  }, [focus, isEditorFocused]);
  useEffect(() => {
    if (initializedRef.current || persistedCollapsed === null) return;
    initializedRef.current = true;
    if ((persistedCollapsed !== "true") !== sidebarVisible) toggleSidebar();
  }, [persistedCollapsed, sidebarVisible, toggleSidebar]);
}

const FeatureEditorTab = memo(
  forwardRef<FeatureEditorTabHandle, FeatureEditorTabProps>(function FeatureEditorTab(props, ref) {
    const layoutFeatureId = useFeatureLayoutContext()?.featureId ?? props.featureId;
    const editor = useEditorState(props.featureId);
    const navigatePane = useEditorStore((state) => state.navigatePane);
    const layoutEditorFocused = useFeatureLayoutStore(
      (state) => getFocusedTab(selectFeatureLayout(layoutFeatureId)(state)) === "editor",
    );
    const isEditorFocused = props.focusedOverride ?? layoutEditorFocused;
    const [fileSearchOpen, setFileSearchOpen] = useState(false);
    const { value: persistedCollapsed, setValue: persistCollapsed } = useDebouncedSetting(
      EDITOR_SIDEBAR_COLLAPSED_SETTING,
      0,
    );
    useFileWatcher(props.projectId, props.featureId);
    const confirmedConflicts = useConfirmedConflictPaths(props.featureId);
    const focus = useEditorFocusState(props.featureId, editor.activePaneId, isEditorFocused);
    const leave = useEditorLeaveGuard(ref, editor.panes, focus);
    const handleToggleSidebar = useCallback(() => {
      editor.toggleSidebar();
      persistCollapsed(String(editor.sidebarVisible));
    }, [editor.sidebarVisible, editor.toggleSidebar, persistCollapsed]);
    useEditorNavigationShortcuts({
      featureId: props.featureId,
      handleToggleSidebar,
      isEditorFocused,
      navigatePane,
    });
    useFeatureEditorEffects({
      focus,
      initFeature: editor.initFeature,
      isEditorFocused,
      persistedCollapsed,
      sidebarVisible: editor.sidebarVisible,
      toggleSidebar: editor.toggleSidebar,
    });
    const isWorktree = Boolean(useFeatureWorktreePath(props.featureId, props.projectId));
    return (
      <FeatureEditorView
        props={props}
        editor={editor}
        focus={focus}
        leave={leave}
        confirmedConflicts={confirmedConflicts}
        fileSearchOpen={fileSearchOpen}
        setFileSearchOpen={setFileSearchOpen}
        isWorktree={isWorktree}
        handleToggleSidebar={handleToggleSidebar}
      />
    );
  }),
);

function FeatureEditorView({
  props,
  editor,
  focus,
  leave,
  confirmedConflicts,
  fileSearchOpen,
  setFileSearchOpen,
  isWorktree,
  handleToggleSidebar,
}: {
  props: FeatureEditorTabProps;
  editor: ReturnType<typeof useEditorState>;
  focus: EditorFocusState;
  leave: EditorLeaveGuard;
  confirmedConflicts: ReturnType<typeof useConfirmedConflictPaths>;
  fileSearchOpen: boolean;
  setFileSearchOpen: (open: boolean) => void;
  isWorktree: boolean;
  handleToggleSidebar: () => void;
}) {
  const openFileSearch = useCallback(() => setFileSearchOpen(true), [setFileSearchOpen]);
  const sidebar = useMemo(
    () => (
      <div className="glass-surface flex h-full flex-col border-r border-border/60 bg-sidebar">
        <SidebarHeader
          isWorktree={isWorktree}
          onToggle={handleToggleSidebar}
          onOpenFileSearch={openFileSearch}
        />
        <div className="flex-1 overflow-hidden">
          <FileTree projectId={props.projectId} featureId={props.featureId} />
        </div>
      </div>
    ),
    [handleToggleSidebar, isWorktree, openFileSearch, props.featureId, props.projectId],
  );
  const editorPane = useMemo(
    () => (
      <EditorSplitTree
        node={editor.splitTree}
        featureId={props.featureId}
        projectId={props.projectId}
        onEditorViewChange={focus.handleEditorViewChange}
      />
    ),
    [editor.splitTree, focus.handleEditorViewChange, props.featureId, props.projectId],
  );
  return (
    <ConfirmedConflictPathsProvider conflicts={confirmedConflicts}>
      <div ref={focus.rootRef} className="flex h-full">
        <EditorLeaveDialog leave={leave} />
        {fileSearchOpen && (
          <FileSearchDialog
            projectId={props.projectId}
            featureId={props.featureId}
            open
            onOpenChange={setFileSearchOpen}
          />
        )}
        <EditorSidebarLayout
          sidebarVisible={editor.sidebarVisible}
          sidebar={sidebar}
          editor={editorPane}
          onToggleSidebar={handleToggleSidebar}
          activeFilePath={editor.panes[editor.activePaneId]?.activeFilePath ?? null}
        />
      </div>
    </ConfirmedConflictPathsProvider>
  );
}

export default FeatureEditorTab;

function SidebarHeader({
  isWorktree,
  onToggle,
  onOpenFileSearch,
}: {
  isWorktree: boolean;
  onToggle: () => void;
  onOpenFileSearch: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {isWorktree && (
          <ShortcutTooltip label="On a worktree branch" alignLeft>
            <GitBranch
              aria-label="On a worktree branch"
              className="h-3.5 w-3.5 shrink-0 text-primary"
            />
          </ShortcutTooltip>
        )}
        <button
          type="button"
          onClick={onOpenFileSearch}
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-border/60 bg-background/40 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Search files…</span>
          <KbdShortcut keys={["cmd", "P"]} size="sm" />
        </button>
      </div>
      <ShortcutTooltip label="Collapse sidebar" keys={["cmd", "E"]} alignRight>
        <button
          type="button"
          aria-label="Collapse file tree sidebar"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onToggle}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
      </ShortcutTooltip>
    </div>
  );
}
