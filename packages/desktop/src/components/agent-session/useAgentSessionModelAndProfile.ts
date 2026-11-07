import { useCallback, useMemo, useState } from "react";
import { PROVIDER_IDS } from "@/lib/providers";
import { useAgentCatalog } from "../../api/agentRuntime";
import { toastError } from "@/lib/api-errors";
import type { AgentSessionProps } from "./types";
import { useAgentSessionModelState } from "./useAgentSessionModelState";
import { useClaudeProfileSelection } from "./useClaudeProfileSelection";

export function useAgentSessionModelAndProfile(
  props: AgentSessionProps,
  agentCatalogData: ReturnType<typeof useAgentCatalog>["data"],
  scrollToBottom: () => void,
) {
  const {
    selection,
    onProviderChange,
    runtimeProvider,
    blocks,
    claudeProfileSelection,
    wsSessionId,
    onSend,
  } = props;

  const model = useAgentSessionModelState({
    agentCatalog: agentCatalogData,
    currentProviderId: selection?.providerId,
    currentModelId: selection?.modelId,
    runtimeProvider,
    onProviderChange,
    hasConversation: blocks.length > 0,
  });

  // Embedded cards run without a catalog, so `model.activeProviderId` is the
  // Claude fallback there; trust the session's known provider instead, or a
  // cold card forwards a profile to a provider that rejects it.
  const profileProviderId = agentCatalogData
    ? model.activeProviderId
    : (selection?.providerId ?? model.activeProviderId);
  const isClaudeProvider =
    profileProviderId === PROVIDER_IDS.CLAUDE_CODE || runtimeProvider === PROVIDER_IDS.CLAUDE_CODE;
  const supportsProfiles = Boolean(
    agentCatalogData?.providers.find((provider) => provider.id === model.activeProviderId)
      ?.profile_capability,
  );
  const sendsProfile = supportsProfiles || isClaudeProvider;

  const localClaudeProfileSelection = useClaudeProfileSelection({
    isClaudeProvider: isClaudeProvider && claudeProfileSelection == null,
    wsSessionId,
  });
  const profile = claudeProfileSelection ?? localClaudeProfileSelection;

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
      scrollToBottom();
      const claudeProfile = sendsProfile ? profile.selectedClaudeProfile : undefined;
      return onSend(message, images, claudeProfile);
    },
    [onSend, profile.selectedClaudeProfile, scrollToBottom, sendsProfile],
  );

  const visibleProviders = useMemo(
    () =>
      model.canChangeProvider
        ? model.providerOptions
        : model.providerOptions.filter((provider) => provider.id === model.activeProviderId),
    [model.activeProviderId, model.canChangeProvider, model.providerOptions],
  );

  return {
    model,
    isClaudeProvider: supportsProfiles || isClaudeProvider,
    profile,
    handleSend,
    visibleProviders,
    isFastModePending,
    handleFastModeChange,
  };
}
