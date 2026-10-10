import { useCallback, useMemo, useState } from "react";
import type { NonAgentTabReadiness } from "@/components/useAgentFirstNonAgentWork";
import {
  claudeProfileForPrompt,
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import { useSessionTabs } from "@/components/WebSocketSessionFeatureBlockTabs";
import { requestAutoReveal } from "@/lib/auto-layout/auto-layout-controller";
import { toRelativePath } from "@/lib/utils";
import { ROOT_LEAF_ID, type TabKind } from "@/stores/feature-layout-schema";
import {
  activateFeatureTab,
  findPaneContaining,
  isTabVisible,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { useEditorStore } from "@/stores/editor-store";
import { useOpenFileInNeovim } from "@/components/editor/neovim/useOpenFileInNeovim";
import type { OpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";

interface DiffFileOpeners {
  /** Git tab and other surfaces: switch to the Editor where it lives. */
  openInPlace: OpenDiffInEditor;
  /**
   * File references clicked in the agent conversation: with auto layout on,
   * the Editor splits in beside the agent instead of replacing it.
   */
  openBesideAgent: OpenDiffInEditor;
}

export function useOpenDiffFileInEditor({
  featureId,
  layoutFeatureId,
  rootPath,
  refs,
}: {
  featureId: number;
  layoutFeatureId: number;
  rootPath: string;
  refs: ReturnType<typeof useSessionRefs>;
}): DiffFileOpeners {
  const openInNeovim = useOpenFileInNeovim(featureId, { ensureStarted: true });

  const open = useCallback(
    (
      filePath: string,
      lineNumber: number | undefined,
      column: number | undefined,
      reveal: () => void,
    ): void => {
      const relativePath = toRelativePath(filePath, rootPath).replace(/^\.\//, "");
      if (openInNeovim) {
        openInNeovim(relativePath, lineNumber, column, reveal);
        return;
      }
      const editor = useEditorStore.getState();
      editor.initFeature(featureId);
      const paneId = useEditorStore.getState().features[featureId]?.activePaneId ?? "main";
      // Always an ordinary open; if Git reports this exact path as unmerged the
      // resolver mounts automatically via `useAutoConflictResolution`.
      editor.openFile(featureId, paneId, relativePath, undefined, lineNumber);
      reveal();
      requestAnimationFrame(() => refs.editor.current?.focusActiveEditor());
    },
    [featureId, openInNeovim, refs.editor, rootPath],
  );

  return useMemo(
    () => ({
      openInPlace: (filePath, lineNumber, column) =>
        open(filePath, lineNumber, column, () => activateFeatureTab(layoutFeatureId, "editor")),
      openBesideAgent: (filePath, lineNumber, column) =>
        open(filePath, lineNumber, column, () =>
          revealEditorBesideAgent(featureId, layoutFeatureId),
        ),
    }),
    [featureId, layoutFeatureId, open],
  );
}

function revealEditorBesideAgent(featureId: number, layoutFeatureId: number): void {
  const outcome = requestAutoReveal(layoutFeatureId, "editor", "user-link");
  if (outcome === "declined") {
    activateFeatureTab(layoutFeatureId, "editor");
    return;
  }
  // The Editor just landed in a narrow pane beside the agent: give the file
  // its width by tucking the tree away (session-only, the preference stays).
  // Not on later clicks, so a tree the user reopened stays open.
  if (outcome === "split" || outcome === "moved") {
    useEditorStore.getState().initFeature(featureId);
    useEditorStore.getState().hideSidebarBesideAgent(featureId);
  }
}

interface AgentDropZone {
  isDragging: boolean;
  onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => void;
}

export function useAgentDropZone(): AgentDropZone {
  const [isDragging, setIsDragging] = useState(false);
  // `dragenter`/`dragleave` bubble from child elements, so moving the cursor
  // between two children of the section would normally flicker isDragging
  // off then back on. We disambiguate by checking `relatedTarget` — only flip
  // to false when the cursor genuinely leaves the section.
  const onDragEnter = useCallback((event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDragEvent(event)) return;
    setIsDragging(true);
  }, []);
  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>): void => {
    if (!isFileDragEvent(event)) return;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setIsDragging(false);
  }, []);
  const onDrop = useCallback((): void => setIsDragging(false), []);
  return { isDragging, onDragEnter, onDragLeave, onDrop };
}

function isFileDragEvent(event: React.DragEvent<HTMLElement>): boolean {
  // Filter out text/link drags so the ring only lights up for actual file
  // attachments. `types` is a DOMStringList in older specs but behaves like
  // an array in Chromium.
  const types = event.dataTransfer?.types;
  if (!types) return false;
  for (const type of types) {
    if (type === "Files") return true;
  }
  return false;
}

export function focusTabTrigger(
  container: HTMLElement,
  layoutFeatureId: number,
  tab: TabKind,
): void {
  const layout = useFeatureLayoutStore.getState().features[layoutFeatureId];
  const paneId = layout ? findPaneContaining(layout.splitRoot, tab)?.id : null;
  const triggers = container.querySelectorAll<HTMLElement>("[data-feature-tab-kind]");
  for (const trigger of triggers) {
    if (trigger.dataset.featureTabKind !== tab) continue;
    if (trigger.dataset.featureId !== String(layoutFeatureId)) continue;
    if (paneId && trigger.closest("[data-pane-id]")?.getAttribute("data-pane-id") !== paneId) {
      continue;
    }
    trigger.focus({ preventScroll: true });
    return;
  }
}

export function useFeatureBlockTabs(args: {
  sessionId: string;
  featureId: number;
  layoutFeatureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
  layoutState: Parameters<typeof isTabVisible>[0];
  tabReady: NonAgentTabReadiness;
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
  openAgentFileInEditor: OpenDiffInEditor;
}): ReturnType<typeof useSessionTabs> {
  return useSessionTabs({
    sessionId: args.sessionId,
    featureId: args.featureId,
    layoutFeatureId: args.layoutFeatureId,
    projectId: args.projectId,
    data: args.data,
    controls: args.controls,
    refs: args.refs,
    agentVisible: isTabVisible(args.layoutState, "agent"),
    tabReady: args.tabReady,
    hotkeysEnabled: args.hotkeysEnabled,
    sendFromGitTab: args.sendFromGitTab,
    openAgentFileInEditor: args.openAgentFileInEditor,
  });
}

export function useSessionFeatureActions({
  layoutFeatureId,
  controls,
  refs,
}: {
  layoutFeatureId: number;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
}): {
  sendPromptAndFocus: (message: string) => void;
  sendFromGitTab: (message: string) => void;
} {
  const setPaneActiveTab = useFeatureLayoutStore((s) => s.setPaneActiveTab);
  const setRootActive = useCallback(
    (tab: TabKind): void => setPaneActiveTab(layoutFeatureId, ROOT_LEAF_ID, tab),
    [layoutFeatureId, setPaneActiveTab],
  );
  const sendPromptAndFocus = useCallback(
    (message: string): void => {
      controls.ws.sendPrompt(message, { claudeProfile: claudeProfileForPrompt(controls) });
      requestAnimationFrame(() => refs.agent.current?.focusPromptBar());
    },
    [controls, refs.agent],
  );
  const sendFromGitTab = useCallback(
    (message: string): void => {
      sendPromptAndFocus(message);
      setRootActive("agent");
    },
    [sendPromptAndFocus, setRootActive],
  );
  return { sendPromptAndFocus, sendFromGitTab };
}
