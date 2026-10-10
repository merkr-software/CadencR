import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import { EditorFuzzyShortcut } from "@/components/editor/EditorFuzzyShortcut";
import {
  OpenDiffInEditorProvider,
  type OpenDiffInEditor,
} from "@/components/diff/OpenDiffInEditorContext";
import { LinkRoutingProvider } from "@/components/links/LinkRoutingProvider";
import { FeatureContentSearchShortcut } from "@/components/FeatureContentSearchShortcut";
import { FeatureTopBar } from "@/components/FeatureTopBar";
import { FeatureLayoutProvider } from "@/components/feature-layout/FeatureLayoutContext";
import { FeatureLayoutShell } from "@/components/feature-layout/FeatureLayoutShell";
import type { TabKind } from "@/stores/feature-layout-schema";
import {
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
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  focusTabTrigger,
  useFeatureBlockTabs,
  useOpenDiffFileInEditor,
  useSessionFeatureActions,
} from "./WebSocketSessionFeatureBlockLocalHooks";
import {
  useNonAgentTabReadiness,
  useSessionPromptDropZone,
} from "./WebSocketSessionFeatureBlockSetup";

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
  onExclude?: () => void;
  requestedFocusTab?: TabKind;
}

function useRequestedTabFocus({
  layoutFeatureId,
  requestedFocusTab,
  requestedFocusPending,
  isMobile,
  refs,
  sectionRef,
}: {
  layoutFeatureId: number;
  requestedFocusTab: TabKind | undefined;
  requestedFocusPending: boolean;
  isMobile: boolean;
  refs: ReturnType<typeof useSessionRefs>;
  sectionRef: RefObject<HTMLElement | null>;
}): void {
  const requestedFocusKeyRef = useRef<string | null>(null);
  useEffect((): (() => void) | void => {
    if (!requestedFocusTab || requestedFocusPending) return;
    const key = `${layoutFeatureId}:${requestedFocusTab}`;
    if (requestedFocusKeyRef.current === key) return;
    requestedFocusKeyRef.current = key;
    const focusRequestedTarget = (): void => {
      if (requestedFocusTab === "agent" && !isMobile) refs.agent.current?.focusPromptBar();
      if (requestedFocusTab === "terminal") refs.terminal.current?.activate();
      if (requestedFocusTab === "editor") refs.editor.current?.focusActiveEditor();
      if (requestedFocusTab === "git" && sectionRef.current) {
        focusTabTrigger(sectionRef.current, layoutFeatureId, requestedFocusTab);
      }
    };
    const frame = requestAnimationFrame(focusRequestedTarget);
    return () => cancelAnimationFrame(frame);
  }, [
    isMobile,
    layoutFeatureId,
    refs.agent,
    refs.editor,
    refs.terminal,
    requestedFocusPending,
    requestedFocusTab,
    sectionRef,
  ]);
}

interface SessionFeatureViewProps {
  props: WebSocketSessionFeatureBlockProps & { layoutFeatureId: number };
  data: ReturnType<typeof useSessionFeatureData>;
  refs: ReturnType<typeof useSessionRefs>;
  tabs: ReturnType<typeof useFeatureBlockTabs>;
  sectionRef: RefObject<HTMLElement | null>;
  openDiffFileInEditor: OpenDiffInEditor;
  promptDropTargetId: string;
  agentDropZone: ReturnType<typeof useSessionPromptDropZone>["agentDropZone"];
  splitsEnabled: boolean;
}

function SessionFeatureView({
  props,
  data,
  refs,
  tabs,
  sectionRef,
  openDiffFileInEditor,
  promptDropTargetId,
  agentDropZone,
  splitsEnabled,
}: SessionFeatureViewProps): ReactElement {
  const {
    featureId,
    projectId,
    layoutFeatureId,
    embedded = false,
    hotkeysEnabled = true,
    onActivate,
  } = props;
  return (
    <LinkRoutingProvider scopeId={featureId}>
      <OpenDiffInEditorProvider onOpenFileInEditor={openDiffFileInEditor}>
        <section
          ref={sectionRef}
          tabIndex={0}
          onFocusCapture={onActivate}
          onPointerDownCapture={onActivate}
          data-agent-prompt-id={promptDropTargetId}
          data-agent-dragover={agentDropZone.isDragging ? "true" : undefined}
          data-feature-chrome={embedded ? "embedded" : "standard"}
          onDragEnter={agentDropZone.onDragEnter}
          onDragLeave={agentDropZone.onDragLeave}
          onDrop={agentDropZone.onDrop}
          className="group/agent-section flex h-full min-h-0 flex-col outline-none"
        >
          {!embedded && (
            <FeatureContentSearchShortcut
              featureId={featureId}
              projectId={projectId}
              layoutFeatureId={layoutFeatureId}
              enabled={hotkeysEnabled}
            />
          )}
          <EditorFuzzyShortcut
            featureId={featureId}
            projectId={projectId}
            enabled={hotkeysEnabled}
          />
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
            onExclude={props.onExclude}
          />
          <FeatureLayoutShell
            featureId={layoutFeatureId}
            tabs={tabs}
            splitsEnabled={splitsEnabled}
            hotkeysEnabled={hotkeysEnabled}
            mountInactiveTabs={false}
            onTerminalActivate={() =>
              requestAnimationFrame(() => refs.terminal.current?.activate())
            }
            onEditorActivate={() =>
              requestAnimationFrame(() => refs.editor.current?.focusActiveEditor())
            }
          />
        </section>
      </OpenDiffInEditorProvider>
    </LinkRoutingProvider>
  );
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
    requestedFocusTab,
  } = props;
  const isMobile = useIsMobile();
  const splitsEnabled = !embedded && !isMobile;
  const layoutState = useFeatureLayoutStore(selectFeatureLayout(layoutFeatureId));
  const requestedFocusPending = useRequestedFeatureFocus(layoutFeatureId, requestedFocusTab);
  const focusedTabId = getFocusedTab(layoutState) ?? "agent";
  const readiness = useNonAgentTabReadiness({
    embedded,
    focusedTabId,
    requestedFocusTab,
    sessionId,
  });

  const gitVisible = isTabVisible(layoutState, "git");
  const data = useSessionFeatureData(sessionId, cwd, featureId, projectId, {
    gitMetadataEnabled: readiness.workEnabled && (!embedded || gitVisible),
    projectLookupEnabled: readiness.workEnabled,
  });
  const controls = useSessionControls(sessionId, featureId, projectId, data.effectiveCwd, {
    loadPersistedState: !embedded,
    agentCatalogEnabled: !embedded && readiness.workEnabled,
  });
  const refs = useSessionRefs();
  const sectionRef = useRef<HTMLElement>(null);
  const { openInPlace: openDiffFileInEditor, openBesideAgent: openAgentFileInEditor } =
    useOpenDiffFileInEditor({
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
    // Avoid opening the on-screen keyboard before mobile users read the transcript.
    autoFocusPrompt: !embedded && !requestedFocusPending && !isMobile,
    autoInitSession: !embedded,
  });
  useRequestedTabFocus({
    layoutFeatureId,
    requestedFocusTab,
    requestedFocusPending,
    isMobile,
    refs,
    sectionRef,
  });
  useWsSessionShortcuts({ controls, hotkeysEnabled });

  const { agentDropZone, promptDropTargetId } = useSessionPromptDropZone(sessionId, featureId);

  const tabs = useFeatureBlockTabs({
    sessionId,
    featureId,
    layoutFeatureId,
    projectId,
    data,
    controls,
    refs,
    layoutState,
    tabReady: readiness.tabReady,
    hotkeysEnabled,
    sendFromGitTab,
    openAgentFileInEditor,
  });

  return (
    <SessionFeatureView
      props={props}
      data={data}
      refs={refs}
      tabs={tabs}
      sectionRef={sectionRef}
      openDiffFileInEditor={openDiffFileInEditor}
      promptDropTargetId={promptDropTargetId}
      agentDropZone={agentDropZone}
      splitsEnabled={splitsEnabled}
    />
  );
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
  onExclude?: () => void;
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
  onExclude,
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
      onExclude={onExclude}
      hideEmbeddedWorktreeSetup={embedded}
    />
  );
}
