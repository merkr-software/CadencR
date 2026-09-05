import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  forwardRef,
  memo,
  type Ref,
} from "react";
import type { AgentPromptBarHandle } from "../AgentPromptBar";
import { useGetFeatureWorkingDir } from "../../api/generated";
import { useAgentCatalog } from "../../api/agentRuntime";
import type { AgentSessionProps, AgentSessionHandle } from "./types";
import { shallowEqualSkipFunctions } from "./shallowEqualSkipFunctions";
import { useAgentSessionScroll } from "./useAgentSessionScroll";
import { useAgentSessionModelAndProfile } from "./useAgentSessionModelAndProfile";
import { useAgentSessionMetaVisibility } from "./useAgentSessionMetaVisibility";
import { useAgentSessionDisplay } from "./useAgentSessionDisplay";
import type { MetaBarHandle } from "./MetaBar";
import { useNarrowContainer } from "./useNarrowContainer";
import { useAutoScrollShortcut } from "./useAutoScrollShortcut";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  AGENT_SUMMARY_MODE_SETTING_KEY,
  AGENT_VERBOSITY_SETTING_KEY,
  parseAgentSummaryMode,
  parseAgentVerbosityMode,
} from "@/lib/agent-verbosity";
import { AgentSessionComposer } from "./AgentSessionComposer";
import { AgentSessionFrame } from "./AgentSessionFrame";
import { AgentSessionStreamContent } from "./AgentSessionStreamContent";
import { AgentSessionProvider } from "./agent-session-context";
import { BranchConfirmDialog } from "./BranchConfirmDialog";
import { useAgentSessionBranchEffects } from "./useAgentSessionBranchEffects";
import { useAgentSessionImperativeHandle } from "./useAgentSessionImperativeHandle";

const META_BAR_COMPACT_THRESHOLD_PX = 640;

function useAgentSessionCollapsible(props: AgentSessionProps, ref: Ref<AgentSessionHandle>) {
  const { status, open: controlledOpen, onToggle, wsSessionId } = props;
  const promptBarRef = useRef<AgentPromptBarHandle>(null);
  const metaBarRef = useRef<MetaBarHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const [internalOpen, setInternalOpen] = useState(true);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  // Auto-open when agent starts running (uncontrolled mode only)
  useEffect(() => {
    if (status !== "idle" && !isControlled) {
      setInternalOpen(true);
    }
  }, [status, isControlled]);

  useAgentSessionImperativeHandle(ref, promptBarRef, containerRef, headerRef, isOpen);

  // Rewind/Fork store reactions (draft prefill + navigate to a new fork),
  // scoped to this session and consumed once each.
  useAgentSessionBranchEffects(wsSessionId, promptBarRef);

  const handleToggle = useCallback(() => {
    if (onToggle) onToggle();
    else setInternalOpen((prev) => !prev);
  }, [onToggle]);

  const handleCollapse = useCallback(() => {
    handleToggle();
    requestAnimationFrame(() => headerRef.current?.focus());
  }, [handleToggle]);

  return {
    promptBarRef,
    metaBarRef,
    containerRef,
    headerRef,
    isOpen,
    handleToggle,
    handleCollapse,
  };
}

function useAgentSessionScrollAndCatalog(props: AgentSessionProps) {
  const {
    blocks,
    featureId,
    projectId,
    wsSessionId,
    agentCatalog: providedAgentCatalog,
    hasMore,
    onLoadOlder,
    agentTabActive = true,
    disableShortcuts,
  } = props;

  const fallbackAgentCatalog = useAgentCatalog({ enabled: providedAgentCatalog == null });
  const agentCatalog = providedAgentCatalog ?? fallbackAgentCatalog;
  const cwdQuery = useGetFeatureWorkingDir(
    featureId ?? 0,
    { project_id: projectId ?? 0 },
    { query: { enabled: featureId != null && projectId != null } },
  );
  const projectPath = cwdQuery.data?.path ?? undefined;

  const verbosityMode = parseAgentVerbosityMode(
    useDebouncedSetting(AGENT_VERBOSITY_SETTING_KEY).value,
  );
  const summaryMode = parseAgentSummaryMode(
    useDebouncedSetting(AGENT_SUMMARY_MODE_SETTING_KEY).value,
  );
  const loadOlder = onLoadOlder
    ? (): Promise<number | void> =>
        onLoadOlder({ summaryMode, compactMode: verbosityMode === "compact" })
    : undefined;
  const scroll = useAgentSessionScroll({
    blocks,
    conversationKey: wsSessionId ?? null,
    hasMore,
    onLoadOlder: loadOlder,
  });
  useAutoScrollShortcut({
    enabled: agentTabActive && !disableShortcuts,
    onEnableAutoScroll: scroll.scrollToBottom,
  });

  return { agentCatalog, projectPath, verbosityMode, summaryMode, scroll };
}

function useAgentSessionState(props: AgentSessionProps, ref: Ref<AgentSessionHandle>) {
  const {
    blocks,
    status,
    pendingQuestions,
    collapsible = false,
    pendingPlanApproval,
    wsSessionId,
  } = props;
  const {
    promptBarRef,
    metaBarRef,
    containerRef,
    headerRef,
    isOpen,
    handleToggle,
    handleCollapse,
  } = useAgentSessionCollapsible(props, ref);
  const { agentCatalog, projectPath, verbosityMode, summaryMode, scroll } =
    useAgentSessionScrollAndCatalog(props);
  const agentSessionContextValue = useMemo(
    () => ({ wsSessionId: wsSessionId ?? null }),
    [wsSessionId],
  );
  const {
    isAgentWorking,
    isTurnActive,
    streamLifecycle,
    workingLabel,
    badge,
    IconComponent,
    displayLabel,
  } = useAgentSessionDisplay(props);
  const isIdle = status === "idle" && blocks.length === 0;
  const shouldShowPromptBar = collapsible
    ? !!pendingPlanApproval ||
      status !== "idle" ||
      blocks.length > 0 ||
      !!(pendingQuestions && pendingQuestions.length > 0)
    : true;
  const {
    model,
    isClaudeProvider,
    profile,
    handleSend,
    visibleProviders,
    isFastModePending,
    handleFastModeChange,
  } = useAgentSessionModelAndProfile(props, agentCatalog.data, scroll.scrollToBottom);
  const isNarrow = useNarrowContainer(containerRef, META_BAR_COMPACT_THRESHOLD_PX);
  const {
    showWorktreeChip,
    showClaudeProfileSelector,
    showAutoScrollChip,
    hasMeta,
    hasSecondaryMeta,
  } = useAgentSessionMetaVisibility(props, isClaudeProvider, isNarrow, shouldShowPromptBar);
  return {
    promptBarRef,
    metaBarRef,
    containerRef,
    headerRef,
    projectPath,
    agentSessionContextValue,
    handleToggle,
    handleCollapse,
    isOpen,
    isAgentWorking,
    isTurnActive,
    streamLifecycle,
    workingLabel,
    verbosityMode,
    summaryMode,
    scroll,
    isIdle,
    shouldShowPromptBar,
    model,
    visibleProviders,
    isClaudeProvider,
    profile,
    handleSend,
    isFastModePending,
    handleFastModeChange,
    showWorktreeChip,
    showClaudeProfileSelector,
    showAutoScrollChip,
    isNarrow,
    hasMeta,
    hasSecondaryMeta,
    badge,
    IconComponent,
    displayLabel,
  };
}

export const AgentSession = memo(
  forwardRef<AgentSessionHandle, AgentSessionProps>(function AgentSession(props, ref) {
    const s = useAgentSessionState(props, ref);

    const streamContent = (
      <AgentSessionStreamContent
        blocks={props.blocks}
        rootBlocks={props.rootBlocks}
        toolResultMap={props.toolResultMap}
        isAgentWorking={s.isAgentWorking}
        turnActive={s.isTurnActive}
        lifecycle={s.streamLifecycle}
        workingLabel={s.workingLabel}
        projectPath={s.projectPath}
        scrollContainerRef={s.scroll.scrollContainerRef}
        virtuosoRef={s.scroll.virtuosoRef}
        followOutput={s.scroll.followOutput}
        onAtBottomStateChange={s.scroll.onAtBottomStateChange}
        onTotalListHeightChanged={s.scroll.onTotalListHeightChanged}
        onStartReached={s.scroll.onStartReached}
        isLoadingOlder={s.scroll.isLoadingOlder}
        historyPrependDisplayOffset={props.historyPrependDisplayOffset}
        verbosityMode={s.verbosityMode}
        summaryMode={s.summaryMode}
        searchEnabled={(props.agentTabActive ?? true) && !props.disableShortcuts}
      />
    );

    const bottomSection = (
      <AgentSessionComposer
        sessionProps={props}
        promptBarRef={s.promptBarRef}
        metaBarRef={s.metaBarRef}
        onSend={s.handleSend}
        onToggleAutoScroll={s.scroll.scrollToBottom}
        onCollapse={s.handleCollapse}
        shouldShowPromptBar={s.shouldShowPromptBar}
        hasMeta={s.hasMeta}
        isNarrow={s.isNarrow}
        hasSecondaryMeta={!!s.hasSecondaryMeta}
        showAutoScrollChip={s.showAutoScrollChip}
        autoScrollEnabled={s.scroll.autoScrollEnabled}
        showWorktreeChip={s.showWorktreeChip}
        activeProviderId={s.model.activeProviderId}
        models={s.model.visibleModels}
        providers={s.visibleProviders}
        canChangeProvider={s.model.canChangeProvider}
        supportedThinkingEfforts={s.model.supportedThinkingEfforts}
        supportsFastMode={s.model.supportsFastMode}
        isFastModePending={s.isFastModePending}
        onFastModeChange={s.handleFastModeChange}
        projectPath={s.projectPath}
        isAgentWorking={s.isAgentWorking}
        agentTabActive={props.agentTabActive ?? true}
        collapsible={props.collapsible ?? false}
        showClaudeProfileSelector={s.showClaudeProfileSelector}
        claudeProfile={s.profile.selectedClaudeProfile}
        claudeProfiles={s.profile.claudeProfiles}
        claudeProfilesLoading={s.profile.claudeProfilesLoading}
        claudeProfilesError={s.profile.claudeProfilesError}
        onClaudeProfileChange={s.profile.handleClaudeProfileChange}
      />
    );

    return (
      <AgentSessionProvider value={s.agentSessionContextValue}>
        {props.wsSessionId && <BranchConfirmDialog wsSessionId={props.wsSessionId} />}
        <AgentSessionFrame
          containerRef={s.containerRef}
          headerRef={s.headerRef}
          collapsible={props.collapsible ?? false}
          className={props.className}
          navAgentIndex={props.navAgentIndex}
          maximized={props.maximized}
          isOpen={s.isOpen}
          isIdle={s.isIdle}
          status={props.status}
          blocks={props.blocks}
          streamContent={streamContent}
          bottomContent={bottomSection}
          onToggle={s.handleToggle}
          IconComponent={s.IconComponent}
          badge={s.badge}
          displayLabel={s.displayLabel}
          onMarkDone={props.onMarkDone}
          resumable={props.resumable}
          onResume={props.onResume}
          canDelete={props.canDelete}
          onDelete={props.onDelete}
          onToggleMaximize={props.onToggleMaximize}
        />
      </AgentSessionProvider>
    );
  }),
  shallowEqualSkipFunctions,
);
