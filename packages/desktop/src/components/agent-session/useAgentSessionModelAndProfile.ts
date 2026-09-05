import { useCallback, useState } from "react";
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

  const isClaudeProvider =
    model.activeProviderId === PROVIDER_IDS.CLAUDE_CODE ||
    runtimeProvider === PROVIDER_IDS.CLAUDE_CODE;

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
      const claudeProfile = isClaudeProvider ? profile.selectedClaudeProfile : undefined;
      return onSend(message, images, claudeProfile);
    },
    [isClaudeProvider, onSend, scrollToBottom, profile.selectedClaudeProfile],
  );

  const visibleProviders = model.canChangeProvider
    ? model.providerOptions
    : model.providerOptions.filter((provider) => provider.id === model.activeProviderId);

  return {
    model,
    isClaudeProvider,
    profile,
    handleSend,
    visibleProviders,
    isFastModePending,
    handleFastModeChange,
  };
}
