import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useImperativeHandle,
  useCallback,
  forwardRef,
  memo,
} from "react";
import { capitalize } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";
import type { AgentPromptBarHandle } from "../AgentPromptBar";
import { AGENT_ICONS } from "../agent-icons";
import { useGetFeatureWorkingDir } from "../../api/generated";
import { useAgentCatalog } from "../../api/agentRuntime";
import { PROVIDER_IDS } from "@/lib/providers";
import { AGENT_LABELS, COMPACTING_BADGE, STATUS_BADGE } from "./constants";
import type { AgentSessionProps, AgentSessionHandle } from "./types";
import { shallowEqualSkipFunctions } from "./shallowEqualSkipFunctions";
import { useAgentSessionScroll } from "./useAgentSessionScroll";
import { useAgentSessionModelState } from "./useAgentSessionModelState";
import type { MetaBarHandle } from "./MetaBar";
import { useNarrowContainer } from "./useNarrowContainer";
import { useAutoScrollShortcut } from "./useAutoScrollShortcut";
import { useTurnWorkingLabel } from "@/components/TurnWorkingLabel";
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
import { useClaudeProfileSelection } from "./useClaudeProfileSelection";
import { AgentSessionProvider } from "./agent-session-context";
import { BranchConfirmDialog } from "./BranchConfirmDialog";
import { useAgentSessionBranchEffects } from "./useAgentSessionBranchEffects";

const META_BAR_COMPACT_THRESHOLD_PX = 640;

export const AgentSession = memo(
  forwardRef<AgentSessionHandle, AgentSessionProps>(function AgentSession(props, ref) {
    const {
      agentType,
      blocks,
      rootBlocks,
      toolResultMap,
      historyPrependDisplayOffset,
      status,
      isCompacting = false,
      lifecycle,
      turnTiming,
      onSend,
      onStop,
      pendingQuestions,
      disableShortcuts,
      label,
      icon,
      collapsible = false,
      className,
      resumable,
      onResume,
      open: controlledOpen,
      onToggle,
      navAgentIndex,
      canDelete,
      onDelete,
      todos,
      onPermissionModeToggle,
      onCodexPermissionModeChange,
      agentCatalog: providedAgentCatalog,
      pendingPlanApproval,
      currentProviderId,
      onProviderChange,
      currentModelId,
      onModelChange,
      showReadOnlyModel,
      featureId,
      projectId,
      wsSessionId,
      onMarkDone,
      maximized,
      onToggleMaximize,
      claudeProfileSelection,
      runtimeProvider,
      runtimeSessionId,
      hasMore,
      onLoadOlder,
      onWorktreeModeChange,
      worktreeProjectId,
      agentTabActive = true,
    } = props;

    const promptBarRef = useRef<AgentPromptBarHandle>(null);
    const metaBarRef = useRef<MetaBarHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);

    const fallbackAgentCatalog = useAgentCatalog({
      enabled: providedAgentCatalog == null,
    });
    const agentCatalog = providedAgentCatalog ?? fallbackAgentCatalog;
    const cwdQuery = useGetFeatureWorkingDir(
      featureId ?? 0,
      { project_id: projectId ?? 0 },
      { query: { enabled: featureId != null && projectId != null } },
    );
    const projectPath = cwdQuery.data?.path ?? undefined;
    // Per-agent components read per-agent state. The global `featureTurnStates`
    // summary is a sidebar-level question ("any agent busy in this feature?");
    // mixing scopes created dual-source bugs where the header showed
    // "In Progress" next to a visible Resume button.
    const isAgentWorking = status === "agent";
    const timerLifecycle = isAgentWorking && !isCompacting ? lifecycle : undefined;
    const streamLifecycle = isAgentWorking ? lifecycle : undefined;
    const turnWorkingLabel = useTurnWorkingLabel(timerLifecycle, turnTiming);
    const workingLabel = isCompacting ? COMPACTING_BADGE.label : turnWorkingLabel;

    // ---- Collapsible state ----
    const [internalOpen, setInternalOpen] = useState(true);
    const isControlled = controlledOpen !== undefined;
    const isOpen = isControlled ? controlledOpen : internalOpen;

    const verbositySetting = useDebouncedSetting(AGENT_VERBOSITY_SETTING_KEY);
    const verbosityMode = parseAgentVerbosityMode(verbositySetting.value);
    const summaryModeSetting = useDebouncedSetting(AGENT_SUMMARY_MODE_SETTING_KEY);
    const summaryMode = parseAgentSummaryMode(summaryModeSetting.value);

    // Older-history loads must be sized to the rows actually rendered, so pass
    // the active display mode down — summary/compact collapse fewer rows than
    // the raw block count, and a mismatch jumps the scroll on prepend.
    const loadOlder = useMemo(
      () =>
        onLoadOlder
          ? (): Promise<number | void> =>
              onLoadOlder({ summaryMode, compactMode: verbosityMode === "compact" })
          : undefined,
      [onLoadOlder, summaryMode, verbosityMode],
    );

    const {
      virtuosoRef,
      scrollContainerRef,
      onStartReached,
      followOutput,
      onAtBottomStateChange,
      onTotalListHeightChanged,
      autoScrollEnabled,
      isLoadingOlder,
      scrollToBottom,
    } = useAgentSessionScroll({
      blocks,
      conversationKey: wsSessionId ?? null,
      hasMore,
      onLoadOlder: loadOlder,
    });

    useAutoScrollShortcut({
      enabled: agentTabActive && !disableShortcuts,
      onEnableAutoScroll: scrollToBottom,
    });

    // Auto-open when agent starts running (uncontrolled mode only)
    useEffect(() => {
      if (status !== "idle" && !isControlled) {
        setInternalOpen(true);
      }
    }, [status, isControlled]);

    useImperativeHandle(
      ref,
      () => ({
        focusPromptBar: () => promptBarRef.current?.focusInput(),
        focusActiveInput: () => {
          const container = containerRef.current;
          const permBtn = container?.querySelector<HTMLElement>("[data-permission-area] button");
          if (permBtn) {
            permBtn.scrollIntoView({ block: "nearest" });
            permBtn.focus();
            return;
          }
          const questionEl = container?.querySelector<HTMLElement>(
            "[data-question-area] button, [data-question-area] input",
          );
          if (questionEl) {
            questionEl.scrollIntoView({ block: "nearest" });
            questionEl.focus();
            return;
          }
          const editable = container?.querySelector<HTMLElement>(
            '[contenteditable="true"], textarea',
          );
          if (editable) {
            editable.scrollIntoView({ block: "nearest" });
            editable.focus();
            return;
          }
          if (headerRef.current) {
            headerRef.current.scrollIntoView({ block: "nearest" });
            headerRef.current.focus();
          }
        },
        isOpen,
      }),
      [isOpen],
    );

    // Identity for the stream subtree (the per-block context menu dispatches
    // rewind/fork against this). Stable per session → no streaming re-renders.
    const agentSessionContextValue = useMemo(
      () => ({ wsSessionId: wsSessionId ?? null }),
      [wsSessionId],
    );

    // Rewind/Fork store reactions (draft prefill + navigate to a new fork),
    // scoped to this session and consumed once each.
    useAgentSessionBranchEffects(wsSessionId, promptBarRef);

    const handleToggle = () => {
      if (onToggle) onToggle();
      else setInternalOpen((prev) => !prev);
    };

    const handleCollapse = () => {
      handleToggle();
      requestAnimationFrame(() => headerRef.current?.focus());
    };

    const isIdle = status === "idle" && blocks.length === 0;
    const badge = isCompacting
      ? COMPACTING_BADGE
      : isAgentWorking
        ? { ...STATUS_BADGE.agent, label: workingLabel }
        : STATUS_BADGE[status];
    const IconComponent = icon ?? AGENT_ICONS[agentType] ?? Loader2Icon;
    const displayLabel = label ?? AGENT_LABELS[agentType] ?? capitalize(agentType);

    const shouldShowPromptBar = (() => {
      if (!collapsible) return true;
      if (pendingPlanApproval) return true;
      return (
        status !== "idle" ||
        blocks.length > 0 ||
        !!(pendingQuestions && pendingQuestions.length > 0)
      );
    })();

    const {
      providerOptions,
      activeProviderId,
      visibleModels,
      currentModelLabel,
      isCatalogLoading,
      canChangeProvider,
      supportedThinkingEfforts,
    } = useAgentSessionModelState({
      agentCatalog: agentCatalog.data,
      currentProviderId,
      currentModelId,
      runtimeProvider,
      onProviderChange,
      hasConversation: blocks.length > 0,
    });

    const isClaudeProvider =
      activeProviderId === PROVIDER_IDS.CLAUDE_CODE || runtimeProvider === PROVIDER_IDS.CLAUDE_CODE;

    const localClaudeProfileSelection = useClaudeProfileSelection({
      isClaudeProvider: isClaudeProvider && claudeProfileSelection == null,
      wsSessionId,
    });
    const {
      selectedClaudeProfile,
      claudeProfiles,
      claudeProfilesLoading,
      claudeProfilesError,
      handleClaudeProfileChange,
    } = claudeProfileSelection ?? localClaudeProfileSelection;

    // Sending a message is an explicit user action — they expect to see
    // their prompt land at the bottom and the agent's reply stream in next
    // to it. Force the chip back on and scroll before deferring to the
    // caller's send handler so the new user_prompt block, when it arrives
    // via WS, lands in view (followOutput keeps it pinned thereafter).
    const handleSend = useCallback(
      (message: string, images?: Parameters<AgentSessionProps["onSend"]>[1]) => {
        scrollToBottom();
        const claudeProfile = isClaudeProvider ? selectedClaudeProfile : undefined;
        return onSend(message, images, claudeProfile);
      },
      [isClaudeProvider, onSend, scrollToBottom, selectedClaudeProfile],
    );

    // Same gate as `canChangeProvider` — see useAgentSessionModelState.
    // The branch/worktree chip shows before the first message when the
    // embedder wires up the mode picker (mode + setter + project id).
    const showWorktreeChip =
      blocks.length === 0 && !!onWorktreeModeChange && worktreeProjectId != null;
    const showClaudeProfileSelector = isClaudeProvider && blocks.length === 0;
    const showAutoScrollChip = !!shouldShowPromptBar;

    const isNarrow = useNarrowContainer(containerRef, META_BAR_COMPACT_THRESHOLD_PX);

    // When narrow, secondary chips (incl. the worktree selector) render below
    // the prompt — so they don't count toward whether the inline `MetaBar`
    // should appear above it.
    const hasInlineMeta =
      !!onPermissionModeToggle ||
      !!onCodexPermissionModeChange ||
      !!onModelChange ||
      showClaudeProfileSelector ||
      !!showReadOnlyModel ||
      (showWorktreeChip && !isNarrow);
    const hasSecondaryMeta =
      showWorktreeChip ||
      showAutoScrollChip ||
      !!(todos && todos.length > 0) ||
      !!(runtimeSessionId && onStop);
    const hasMeta = hasInlineMeta || (hasSecondaryMeta && !isNarrow);

    const visibleProviders = canChangeProvider
      ? providerOptions
      : providerOptions.filter((provider) => provider.id === activeProviderId);
    const streamContent = (
      <AgentSessionStreamContent
        blocks={blocks}
        rootBlocks={rootBlocks}
        toolResultMap={toolResultMap}
        isAgentWorking={isAgentWorking}
        lifecycle={streamLifecycle}
        workingLabel={workingLabel}
        projectPath={projectPath}
        scrollContainerRef={scrollContainerRef}
        virtuosoRef={virtuosoRef}
        followOutput={followOutput}
        onAtBottomStateChange={onAtBottomStateChange}
        onTotalListHeightChanged={onTotalListHeightChanged}
        onStartReached={onStartReached}
        isLoadingOlder={isLoadingOlder}
        historyPrependDisplayOffset={historyPrependDisplayOffset}
        verbosityMode={verbosityMode}
        summaryMode={summaryMode}
        searchEnabled={agentTabActive && !disableShortcuts}
      />
    );

    const bottomSection = (
      <AgentSessionComposer
        sessionProps={props}
        promptBarRef={promptBarRef}
        metaBarRef={metaBarRef}
        onSend={handleSend}
        onToggleAutoScroll={scrollToBottom}
        onCollapse={handleCollapse}
        shouldShowPromptBar={shouldShowPromptBar}
        hasMeta={hasMeta}
        isNarrow={isNarrow}
        hasSecondaryMeta={!!hasSecondaryMeta}
        showAutoScrollChip={showAutoScrollChip}
        autoScrollEnabled={autoScrollEnabled}
        showWorktreeChip={showWorktreeChip}
        activeProviderId={activeProviderId}
        currentModelLabel={currentModelLabel ?? ""}
        isModelCatalogLoading={isCatalogLoading}
        models={visibleModels}
        providers={visibleProviders}
        canChangeProvider={canChangeProvider}
        supportedThinkingEfforts={supportedThinkingEfforts}
        projectPath={projectPath}
        isAgentWorking={isAgentWorking}
        agentTabActive={agentTabActive}
        collapsible={collapsible}
        showClaudeProfileSelector={showClaudeProfileSelector}
        claudeProfile={selectedClaudeProfile}
        claudeProfiles={claudeProfiles}
        claudeProfilesLoading={claudeProfilesLoading}
        claudeProfilesError={claudeProfilesError}
        onClaudeProfileChange={handleClaudeProfileChange}
      />
    );

    return (
      <AgentSessionProvider value={agentSessionContextValue}>
        {wsSessionId && <BranchConfirmDialog wsSessionId={wsSessionId} />}
        <AgentSessionFrame
          containerRef={containerRef}
          headerRef={headerRef}
          collapsible={collapsible}
          className={className}
          navAgentIndex={navAgentIndex}
          maximized={maximized}
          isOpen={isOpen}
          isIdle={isIdle}
          status={status}
          blocks={blocks}
          streamContent={streamContent}
          bottomContent={bottomSection}
          onToggle={handleToggle}
          IconComponent={IconComponent}
          badge={badge}
          displayLabel={displayLabel}
          onMarkDone={onMarkDone}
          resumable={resumable}
          onResume={onResume}
          canDelete={canDelete}
          onDelete={onDelete}
          onToggleMaximize={onToggleMaximize}
        />
      </AgentSessionProvider>
    );
  }),
  shallowEqualSkipFunctions,
);
