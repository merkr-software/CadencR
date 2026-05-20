import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { EditorFuzzyShortcut } from "@/components/editor/EditorFuzzyShortcut";
import { OpenDiffInEditorProvider } from "@/components/diff/OpenDiffInEditorContext";
import { FeatureContentSearchShortcut } from "@/components/FeatureContentSearchShortcut";
import { FeatureTopBar } from "@/components/FeatureTopBar";
import { FeatureLayoutProvider } from "@/components/feature-layout/FeatureLayoutContext";
import { FeatureLayoutShell } from "@/components/feature-layout/FeatureLayoutShell";
import { ROOT_LEAF_ID, type TabKind } from "@/stores/feature-layout-schema";
import {
  activateFeatureTab,
  findPaneContaining,
  getFocusedTab,
  isTabVisible,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";
import { useRequestedFeatureFocus } from "@/hooks/useRequestedFeatureFocus";
import {
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
  useWsSessionEffects,
  useWsSessionShortcuts,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import { useSessionTabs } from "@/components/WebSocketSessionFeatureBlockTabs";
import { useEditorStore } from "@/stores/editor-store";
import { toRelativePath } from "@/lib/utils";

export interface WebSocketSessionFeatureBlockProps {
  sessionId: string;
  cwd: string;
  featureId: number;
  projectId: number;
  layoutFeatureId?: number;
  embedded?: boolean;
  hotkeysEnabled?: boolean;
  onActivate?: () => void;
  projectName?: string;
  featureTitle?: string;
  featureLabel?: string | null;
  lastActivityAt?: string | null;
  isPinned?: boolean;
  isPinPending?: boolean;
  onTogglePin?: () => void;
  requestedFocusTab?: TabKind;
}

export function WebSocketSessionFeatureBlock(
  props: WebSocketSessionFeatureBlockProps,
): ReactElement {
  const layoutFeatureId = props.layoutFeatureId ?? props.featureId;
  return (
    <FeatureLayoutProvider
      featureId={layoutFeatureId}
      hotkeysEnabled={props.hotkeysEnabled ?? true}
    >
      <WebSocketSessionFeatureBody {...props} layoutFeatureId={layoutFeatureId} />
    </FeatureLayoutProvider>
  );
}

function WebSocketSessionFeatureBody(
  props: WebSocketSessionFeatureBlockProps & { layoutFeatureId: number },
): ReactElement {
  const {
    sessionId,
    cwd,
    featureId,
    projectId,
    layoutFeatureId,
    embedded = false,
    hotkeysEnabled = true,
    onActivate,
    requestedFocusTab,
  } = props;
  const layoutState = useFeatureLayoutStore(selectFeatureLayout(layoutFeatureId));
  const requestedFocusPending = useRequestedFeatureFocus(layoutFeatureId, requestedFocusTab);
  const focusedTabId = getFocusedTab(layoutState) ?? "agent";

  // `useSaveLastOpenedFeature` is mounted once at the route level; we used to
  // also call it here, which produced a duplicate
  // `PUT /api/workspace/settings/lastOpenedFeature` on every open.
  const gitVisible = isTabVisible(layoutState, "git");
  const data = useSessionFeatureData(sessionId, cwd, featureId, projectId, {
    gitMetadataEnabled: !embedded || gitVisible,
    projectLookupEnabled: !embedded,
  });
  const controls = useSessionControls(sessionId, featureId, projectId, cwd, data.featureSettings, {
    loadPersistedState: !embedded,
  });
  const refs = useSessionRefs();
  const requestedFocusKeyRef = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const openDiffFileInEditor = useOpenDiffFileInEditor({
    featureId,
    layoutFeatureId,
    rootPath: data.effectiveCwd || data.projectPath || cwd,
    refs,
  });

  const { sendFromGitTab } = useSessionFeatureActions({ layoutFeatureId, controls, refs });

  useWsSessionEffects({
    sessionId,
    cwd,
    featureId,
    data,
    controls,
    refs,
    focusedTabId,
    hotkeysEnabled,
    autoFocusPrompt: !embedded && !requestedFocusPending,
    autoInitSession: !embedded,
  });
  useEffect((): (() => void) | void => {
    if (!requestedFocusTab || requestedFocusPending) return;

    const key = `${layoutFeatureId}:${requestedFocusTab}`;
    if (requestedFocusKeyRef.current === key) return;
    requestedFocusKeyRef.current = key;
    const focusRequestedTarget = (): void => {
      if (requestedFocusTab === "agent") refs.agent.current?.focusPromptBar();
      if (requestedFocusTab === "terminal") refs.terminal.current?.activate();
      if (requestedFocusTab === "editor") refs.editor.current?.focusActiveEditor();
      if (requestedFocusTab === "git" && sectionRef.current) {
        focusTabTrigger(sectionRef.current, layoutFeatureId, requestedFocusTab);
      }
    };
    const frame = requestAnimationFrame(focusRequestedTarget);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [
    layoutFeatureId,
    refs.agent,
    refs.editor,
    refs.terminal,
    requestedFocusTab,
    requestedFocusPending,
  ]);
  useWsSessionShortcuts({ controls, hotkeysEnabled });

  const tabs = useFeatureBlockTabs({
    sessionId,
    featureId,
    projectId,
    data,
    controls,
    refs,
    layoutState,
    hotkeysEnabled,
    sendFromGitTab,
  });

  return (
    <OpenDiffInEditorProvider onOpenFileInEditor={openDiffFileInEditor}>
      <section
        ref={sectionRef}
        tabIndex={0}
        onFocusCapture={onActivate}
        onPointerDownCapture={onActivate}
        className="flex h-full min-h-0 flex-col outline-none"
      >
        {!embedded && (
          <FeatureContentSearchShortcut
            featureId={featureId}
            projectId={projectId}
            layoutFeatureId={layoutFeatureId}
            enabled={hotkeysEnabled}
          />
        )}
        <EditorFuzzyShortcut featureId={featureId} projectId={projectId} enabled={hotkeysEnabled} />
        <SessionFeatureTopBar
          featureId={featureId}
          projectId={projectId}
          embedded={embedded}
          data={data}
          projectName={props.projectName}
          featureTitle={props.featureTitle}
          featureLabel={props.featureLabel}
          lastActivityAt={props.lastActivityAt}
          isPinned={props.isPinned}
          isPinPending={props.isPinPending}
          onTogglePin={props.onTogglePin}
        />
        <FeatureLayoutShell
          featureId={layoutFeatureId}
          tabs={tabs}
          splitsEnabled={!embedded}
          hotkeysEnabled={hotkeysEnabled}
          mountInactiveTabs={!embedded}
          onTerminalActivate={() => requestAnimationFrame(() => refs.terminal.current?.activate())}
          onEditorActivate={() =>
            requestAnimationFrame(() => refs.editor.current?.focusActiveEditor())
          }
        />
      </section>
    </OpenDiffInEditorProvider>
  );
}

function useOpenDiffFileInEditor({
  featureId,
  layoutFeatureId,
  rootPath,
  refs,
}: {
  featureId: number;
  layoutFeatureId: number;
  rootPath: string;
  refs: ReturnType<typeof useSessionRefs>;
}): (filePath: string, lineNumber?: number) => void {
  return useCallback(
    (filePath: string, lineNumber?: number): void => {
      const editor = useEditorStore.getState();
      editor.initFeature(featureId);
      const feature = useEditorStore.getState().features[featureId];
      const paneId = feature?.activePaneId ?? "main";
      editor.openFile(
        featureId,
        paneId,
        toRelativePath(filePath, rootPath).replace(/^\.\//, ""),
        undefined,
        lineNumber,
      );
      activateFeatureTab(layoutFeatureId, "editor");
      requestAnimationFrame(() => refs.editor.current?.focusActiveEditor());
    },
    [featureId, layoutFeatureId, refs.editor, rootPath],
  );
}

function focusTabTrigger(container: HTMLElement, layoutFeatureId: number, tab: TabKind): void {
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

function useFeatureBlockTabs(args: {
  sessionId: string;
  featureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
  layoutState: Parameters<typeof isTabVisible>[0];
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
}): ReturnType<typeof useSessionTabs> {
  return useSessionTabs({
    sessionId: args.sessionId,
    featureId: args.featureId,
    projectId: args.projectId,
    data: args.data,
    controls: args.controls,
    refs: args.refs,
    agentVisible: isTabVisible(args.layoutState, "agent"),
    hotkeysEnabled: args.hotkeysEnabled,
    sendFromGitTab: args.sendFromGitTab,
  });
}

function useSessionFeatureActions({
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
      controls.ws.sendPrompt(message);
      requestAnimationFrame(() => refs.agent.current?.focusPromptBar());
    },
    [controls.ws, refs.agent],
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

interface SessionFeatureTopBarProps {
  featureId: number;
  projectId: number;
  embedded: boolean;
  data: ReturnType<typeof useSessionFeatureData>;
  projectName?: string;
  featureTitle?: string;
  featureLabel?: string | null;
  lastActivityAt?: string | null;
  isPinned?: boolean;
  isPinPending?: boolean;
  onTogglePin?: () => void;
}

function SessionFeatureTopBar({
  featureId,
  projectId,
  embedded,
  data,
  projectName,
  featureTitle,
  featureLabel,
  lastActivityAt,
  isPinned,
  isPinPending,
  onTogglePin,
}: SessionFeatureTopBarProps): ReactElement {
  return (
    <FeatureTopBar
      featureId={featureId}
      projectId={projectId}
      mode="session"
      className={embedded ? "" : "shrink-0"}
      wsWorktreeStatus={embedded ? data.worktreeStatus : data.session?.worktreeStatus}
      wsWorktreeBranch={embedded ? data.worktreeBranch : data.session?.worktreeBranch}
      wsWorktreeSetupOutput={data.session?.worktreeSetupOutput}
      wsWorktreeError={data.session?.worktreeError}
      onRetryWorktreeSetup={data.handleRetryWorktreeSetup}
      showCustomActions={!embedded}
      showSidebarChrome={!embedded}
      draggable={!embedded}
      projectName={projectName}
      titleOverride={featureTitle}
      labelOverride={featureLabel}
      lastActivityAt={lastActivityAt}
      isPinned={isPinned}
      isPinPending={isPinPending}
      onTogglePin={onTogglePin}
      hideEmbeddedWorktreeSetup={embedded}
    />
  );
}
