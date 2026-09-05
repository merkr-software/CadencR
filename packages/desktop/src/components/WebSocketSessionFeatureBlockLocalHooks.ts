import { useCallback, useState } from "react";
import type { NonAgentTabReadiness } from "@/components/useAgentFirstNonAgentWork";
import {
  claudeProfileForPrompt,
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import { useSessionTabs } from "@/components/WebSocketSessionFeatureBlockTabs";
import { toRelativePath } from "@/lib/utils";
import { ROOT_LEAF_ID, type TabKind } from "@/stores/feature-layout-schema";
import {
  activateFeatureTab,
  findPaneContaining,
  isTabVisible,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { useEditorStore } from "@/stores/editor-store";
import { useOpenFileRoute, useStartRoute } from "@/api/generated";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { apiErrorMessage } from "@/lib/api-errors";
import { toast } from "sonner";
import type { OpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";

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
}): OpenDiffInEditor {
  const vimModeLevel = useVimModeLevel();
  const { mutateAsync: startNeovim } = useStartRoute();
  const { mutateAsync: openInNeovim } = useOpenFileRoute();

  const openInCodeMirror = useCallback(
    (filePath: string, lineNumber?: number): void => {
      const editor = useEditorStore.getState();
      editor.initFeature(featureId);
      const feature = useEditorStore.getState().features[featureId];
      const paneId = feature?.activePaneId ?? "main";
      const relativePath = toRelativePath(filePath, rootPath).replace(/^\.\//, "");
      // Always an ordinary open; if Git reports this exact path as unmerged the
      // resolver mounts automatically via `useAutoConflictResolution`.
      editor.openFile(featureId, paneId, relativePath, undefined, lineNumber);
      activateFeatureTab(layoutFeatureId, "editor");
      requestAnimationFrame(() => refs.editor.current?.focusActiveEditor());
    },
    [featureId, layoutFeatureId, refs.editor, rootPath],
  );

  return useCallback(
    (filePath, lineNumber, column): void => {
      if (vimModeLevel !== "2") {
        openInCodeMirror(filePath, lineNumber);
        return;
      }

      const relativePath = toRelativePath(filePath, rootPath).replace(/^\.\//, "");
      const idString = String(featureId);
      // `start` is idempotent — safe to call even if the session is already
      // running, and this is the only way a click reaches the panel before
      // the user has opened it themselves.
      void startNeovim({ data: featureId })
        .then(() =>
          openInNeovim({
            featureId: idString,
            data: { path: relativePath, line: lineNumber, col: column },
          }),
        )
        .then(() => activateFeatureTab(layoutFeatureId, "editor"))
        .catch((error: unknown) => {
          toast.error(apiErrorMessage(error, "Could not open file in Neovim"));
        });
    },
    [
      featureId,
      layoutFeatureId,
      openInCodeMirror,
      openInNeovim,
      rootPath,
      startNeovim,
      vimModeLevel,
    ],
  );
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
