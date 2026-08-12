import { useCallback, useEffect, useMemo, useRef, useState, type ForwardedRef } from "react";
import { Loader2Icon } from "lucide-react";
import { useGetFeatureWorkingDir } from "@/api/generated";
import { useAgentCatalog } from "@/api/agentRuntime";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { toastError } from "@/lib/api-errors";
import {
  AGENT_SUMMARY_MODE_SETTING_KEY,
  AGENT_VERBOSITY_SETTING_KEY,
  parseAgentSummaryMode,
  parseAgentVerbosityMode,
} from "@/lib/agent-verbosity";
import { PROVIDER_IDS } from "@/lib/providers";
import { capitalize } from "@/lib/utils";
import type { AgentPromptBarHandle } from "../AgentPromptBar";
import { AGENT_ICONS } from "../agent-icons";
import { useTurnWorkingLabel } from "../TurnWorkingLabel";
import { COMPACTING_BADGE, AGENT_LABELS, STATUS_BADGE } from "./constants";
import type { MetaBarHandle } from "./MetaBar";
import type { AgentSessionHandle, AgentSessionProps } from "./types";
import { useAgentSessionBranchEffects } from "./useAgentSessionBranchEffects";
import { useAgentSessionImperativeHandle } from "./useAgentSessionImperativeHandle";
import { useAgentSessionModelState } from "./useAgentSessionModelState";
import { useAgentSessionScroll } from "./useAgentSessionScroll";
import { useAutoScrollShortcut } from "./useAutoScrollShortcut";
import { useClaudeProfileSelection } from "./useClaudeProfileSelection";
import { useNarrowContainer } from "./useNarrowContainer";

const META_BAR_COMPACT_THRESHOLD_PX = 640;

function useAgentSessionBase(props: AgentSessionProps, ref: ForwardedRef<AgentSessionHandle>) {
  const promptBarRef = useRef<AgentPromptBarHandle>(null);
  const metaBarRef = useRef<MetaBarHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const fallbackCatalog = useAgentCatalog({ enabled: props.agentCatalog == null });
  const agentCatalog = props.agentCatalog ?? fallbackCatalog;
  const cwdQuery = useGetFeatureWorkingDir(
    props.featureId ?? 0,
    { project_id: props.projectId ?? 0 },
    { query: { enabled: props.featureId != null && props.projectId != null } },
  );
  const isAgentWorking = props.status === "agent";
  const isTurnActive = props.status !== "idle";
  const timerLifecycle =
    isAgentWorking && !(props.isCompacting ?? false) ? props.lifecycle : undefined;
  const streamLifecycle = isAgentWorking ? props.lifecycle : undefined;
  const turnWorkingLabel = useTurnWorkingLabel(timerLifecycle, props.turnTiming);
  const workingLabel = props.isCompacting ? COMPACTING_BADGE.label : turnWorkingLabel;
  const [internalOpen, setInternalOpen] = useState(true);
  const isControlled = props.open !== undefined;
  const isOpen = props.open ?? internalOpen;
  const verbositySetting = useDebouncedSetting(AGENT_VERBOSITY_SETTING_KEY);
  const summarySetting = useDebouncedSetting(AGENT_SUMMARY_MODE_SETTING_KEY);
  const verbosityMode = parseAgentVerbosityMode(verbositySetting.value);
  const summaryMode = parseAgentSummaryMode(summarySetting.value);
  const loadOlder = useMemo(() => {
    const onLoadOlder = props.onLoadOlder;
    return onLoadOlder
      ? (): Promise<number | void> =>
          onLoadOlder({ summaryMode, compactMode: verbosityMode === "compact" })
      : undefined;
  }, [props.onLoadOlder, summaryMode, verbosityMode]);
  const scroll = useAgentSessionScroll({
    blocks: props.blocks,
    conversationKey: props.wsSessionId ?? null,
    hasMore: props.hasMore,
    onLoadOlder: loadOlder,
  });
  useAutoScrollShortcut({
    enabled: (props.agentTabActive ?? true) && !props.disableShortcuts,
    onEnableAutoScroll: scroll.scrollToBottom,
  });
  useEffect(() => {
    if (props.status !== "idle" && !isControlled) setInternalOpen(true);
  }, [isControlled, props.status]);
  useAgentSessionImperativeHandle(ref, promptBarRef, containerRef, headerRef, isOpen);
  useAgentSessionBranchEffects(props.wsSessionId, promptBarRef);
  const handleToggle = useCallback((): void => {
    if (props.onToggle) props.onToggle();
    else setInternalOpen((open) => !open);
  }, [props.onToggle]);
  const handleCollapse = useCallback((): void => {
    handleToggle();
    requestAnimationFrame(() => headerRef.current?.focus());
  }, [handleToggle]);
  const badge = props.isCompacting
    ? COMPACTING_BADGE
    : isAgentWorking
      ? { ...STATUS_BADGE.agent, label: workingLabel }
      : STATUS_BADGE[props.status];
  const shouldShowPromptBar =
    !props.collapsible ||
    !!props.pendingPlanApproval ||
    props.status !== "idle" ||
    props.blocks.length > 0 ||
    !!props.pendingQuestions?.length;
  return {
    agentCatalog,
    badge,
    containerRef,
    displayLabel: props.label ?? AGENT_LABELS[props.agentType] ?? capitalize(props.agentType),
    handleCollapse,
    handleToggle,
    headerRef,
    IconComponent: props.icon ?? AGENT_ICONS[props.agentType] ?? Loader2Icon,
    isAgentWorking,
    isIdle: props.status === "idle" && props.blocks.length === 0,
    isOpen,
    isTurnActive,
    metaBarRef,
    projectPath: cwdQuery.data?.path ?? undefined,
    promptBarRef,
    scroll,
    shouldShowPromptBar,
    streamLifecycle,
    summaryMode,
    verbosityMode,
    workingLabel,
  };
}

type AgentSessionBase = ReturnType<typeof useAgentSessionBase>;

function useAgentSessionMeta(props: AgentSessionProps, base: AgentSessionBase) {
  const model = useAgentSessionModelState({
    agentCatalog: base.agentCatalog.data,
    currentProviderId: props.currentProviderId,
    currentModelId: props.currentModelId,
    runtimeProvider: props.runtimeProvider,
    onProviderChange: props.onProviderChange,
    hasConversation: props.blocks.length > 0,
  });
  const isClaudeProvider =
    model.modelSelectionStatus === "ready" && model.activeProviderId === PROVIDER_IDS.CLAUDE_CODE;
  const localProfile = useClaudeProfileSelection({
    isClaudeProvider: isClaudeProvider && props.claudeProfileSelection == null,
    wsSessionId: props.wsSessionId,
  });
  const profile = props.claudeProfileSelection ?? localProfile;
  const [isFastModePending, setIsFastModePending] = useState(false);
  const handleFastModeChange = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!props.onFastModeChange || isFastModePending) return;
      setIsFastModePending(true);
      try {
        await props.onFastModeChange(enabled);
      } catch (error) {
        toastError(error, "Could not update fast mode");
      } finally {
        setIsFastModePending(false);
      }
    },
    [isFastModePending, props.onFastModeChange],
  );
  const handleSend = useCallback(
    (message: string, images?: Parameters<AgentSessionProps["onSend"]>[1]) => {
      base.scroll.scrollToBottom();
      const claudeProfile = isClaudeProvider ? profile.selectedClaudeProfile : undefined;
      return props.onSend(message, images, claudeProfile);
    },
    [base.scroll, isClaudeProvider, profile.selectedClaudeProfile, props.onSend],
  );
  const showWorktreeChip =
    props.blocks.length === 0 && !!props.onWorktreeModeChange && props.worktreeProjectId != null;
  const showClaudeProfileSelector = isClaudeProvider && props.blocks.length === 0;
  const showAutoScrollChip = !!base.shouldShowPromptBar;
  const isNarrow = useNarrowContainer(base.containerRef, META_BAR_COMPACT_THRESHOLD_PX);
  const hasInlineMeta =
    !!props.onPermissionModeToggle ||
    !!props.onAccessModeChange ||
    !!props.onModelChange ||
    !!props.sessionConfigControls ||
    showClaudeProfileSelector ||
    !!props.showReadOnlyModel ||
    (showWorktreeChip && !isNarrow);
  const hasSecondaryMeta =
    showWorktreeChip ||
    showAutoScrollChip ||
    !!props.todos?.length ||
    !!(props.runtimeSessionId && props.onStop);
  const visibleProviders = model.canChangeProvider
    ? model.providerOptions
    : model.providerOptions.filter((provider) => provider.id === model.activeProviderId);
  return {
    handleSend,
    handleFastModeChange,
    hasMeta: hasInlineMeta || (hasSecondaryMeta && !isNarrow),
    hasSecondaryMeta,
    isNarrow,
    isFastModePending,
    model,
    profile,
    showAutoScrollChip,
    showClaudeProfileSelector,
    showWorktreeChip,
    visibleProviders,
  };
}

export function useAgentSessionController(
  props: AgentSessionProps,
  ref: ForwardedRef<AgentSessionHandle>,
) {
  const base = useAgentSessionBase(props, ref);
  const meta = useAgentSessionMeta(props, base);
  const contextValue = useMemo(
    () => ({ wsSessionId: props.wsSessionId ?? null }),
    [props.wsSessionId],
  );
  return { base, contextValue, meta };
}

export type AgentSessionController = ReturnType<typeof useAgentSessionController>;
