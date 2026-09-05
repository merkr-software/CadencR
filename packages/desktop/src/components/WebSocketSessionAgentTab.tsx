import { useCallback, useMemo, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";
import { AgentSession } from "@/components/agent-session";
import { SessionInfoMcpServersProvider } from "@/components/agent-session/SessionInfoChip";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import { resolveWorktreeChoice } from "@/lib/worktree-mode";
import { checkoutSelectedBranch, saveWorktreeChoice } from "@/components/worktree-send-helpers";
import type { FirstPromptBranchSetup } from "@/lib/ws-envelope";
import type { FeatureTabDef } from "@/components/feature-layout/types";
import { useCheckoutBranch, useSetFeatureSetting } from "@/api/generated";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import {
  claudeProfileForPrompt,
  type useSessionControls,
  type useSessionFeatureData,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import { COMPACT_ACTION_PROVIDERS } from "@/lib/providers";
import type { UseSessionTabsArgs } from "./WebSocketSessionFeatureBlockTabs";

import type { SessionConfigControls } from "./agent-session/types";

function useSessionConfigControls(
  controls: ReturnType<typeof useSessionControls>,
): SessionConfigControls | undefined {
  return useMemo<SessionConfigControls | undefined>(
    () =>
      controls.ws.runtimeSessionId
        ? {
            config: controls.ws.sessionConfig,
            loading: controls.ws.sessionConfigLoading,
            supported: controls.ws.sessionConfigSupported,
            error: controls.ws.sessionConfigError,
            pendingId: controls.ws.pendingSessionConfigId,
            onRefresh: controls.ws.requestSessionConfig,
            onChange: controls.ws.setSessionConfigOption,
          }
        : undefined,
    [
      controls.ws.pendingSessionConfigId,
      controls.ws.requestSessionConfig,
      controls.ws.runtimeSessionId,
      controls.ws.sessionConfig,
      controls.ws.sessionConfigError,
      controls.ws.sessionConfigLoading,
      controls.ws.sessionConfigSupported,
      controls.ws.setSessionConfigOption,
    ],
  );
}

function AgentTabContent({
  args,
  onSend,
  hasAccessModes,
}: {
  args: UseSessionTabsArgs;
  onSend: ReturnType<typeof useAgentSendHandler>;
  hasAccessModes: boolean;
}): ReactElement {
  const { sessionId, featureId, projectId, data, controls, refs, agentVisible, hotkeysEnabled } =
    args;
  const sessionConfigControls = useSessionConfigControls(controls);
  return (
    <SessionInfoMcpServersProvider mcpServers={controls.ws.mcpServers}>
      <AgentSession
        ref={refs.agent}
        agentType="session"
        featureId={featureId}
        projectId={projectId}
        wsSessionId={sessionId}
        blocks={controls.ws.blocks}
        rootBlocks={controls.ws.rootBlocks}
        toolResultMap={controls.ws.toolResultMap}
        historyPrependDisplayOffset={controls.ws.historyPrependDisplayOffset}
        status={controls.ws.status}
        isCompacting={controls.ws.isCompacting}
        lifecycle={controls.ws.lifecycle}
        turnTiming={controls.ws.turnTiming}
        onSend={onSend}
        onStop={controls.ws.interrupt}
        disabled={hasAccessModes && controls.isAccessModePending}
        pendingPermission={controls.ws.pendingPermission}
        onPermissionDecision={(decision, feedback, optionId) => {
          controls.ws.respondToPermission(
            controls.ws.pendingRequestId,
            decision,
            feedback,
            optionId,
          );
        }}
        isSubmittingPermission={controls.ws.isSubmittingPermission}
        pendingQuestions={
          controls.ws.pendingQuestions.length > 0 ? controls.ws.pendingQuestions : undefined
        }
        onAnswerSubmit={controls.ws.respondToQuestion}
        permissionMode={controls.ws.permissionMode}
        enabledOptInModes={controls.enabledOptInModes}
        providerModes={controls.providerModes}
        providerAccessModes={controls.providerAccessModes}
        accessMode={hasAccessModes ? controls.accessMode : undefined}
        accessModeDefault={hasAccessModes ? controls.accessModeDefault : undefined}
        isAccessModePending={hasAccessModes ? controls.isAccessModePending : false}
        onAccessModeChange={hasAccessModes ? controls.handleAccessModeChange : undefined}
        agentCatalog={controls.agentCatalog}
        onPermissionModeToggle={controls.handlePermissionModeToggle}
        pendingPlanApproval={controls.ws.pendingPlanApproval}
        onPlanApprove={controls.ws.approvePlan}
        onPlanRequestChanges={controls.ws.requestPlanChanges}
        onGateClose={() => controls.ws.closeGate("escape")}
        contextUsage={controls.ws.contextUsage}
        selection={controls.ws.currentSelection}
        onProviderChange={controls.ws.setProvider}
        onModelChange={(nextProviderId, modelId) =>
          handleModelChange(nextProviderId, modelId, controls)
        }
        currentThinkingEffort={controls.ws.currentThinkingEffort}
        onThinkingEffortChange={controls.ws.setThinkingEffort}
        fastMode={controls.ws.fastMode}
        onFastModeChange={controls.ws.setFastMode}
        runtimeProvider={controls.ws.currentSelection?.providerId}
        runtimeSessionId={controls.ws.runtimeSessionId || undefined}
        sessionConfigControls={sessionConfigControls}
        slashCommandsOverride={data.session?.slashCommands ?? []}
        slashCommandsLoading={data.session?.slashCommandsLoading ?? false}
        promptCommandPolicy={data.session?.promptCommandPolicy}
        todos={agentVisible ? (data.session?.todos ?? null) : null}
        disableShortcuts={!hotkeysEnabled}
        agentTabActive={agentVisible && hotkeysEnabled}
        claudeProfileSelection={controls.claudeProfile}
        hasMore={controls.ws.hasMore}
        onLoadOlder={controls.ws.loadOlderMessages}
        worktreeMode={controls.worktreeMode}
        onWorktreeModeChange={controls.setWorktreeMode}
        worktreeProjectId={projectId}
        worktreeDefaultBranch={data.defaultBranch}
        worktreeProjectPath={data.projectPath}
        worktreeSelectedBranch={controls.selectedBranch}
        onWorktreeBranchChange={controls.setSelectedBranch}
        className="h-full"
      />
    </SessionInfoMcpServersProvider>
  );
}

export function useAgentTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { sessionId, featureId, projectId, data, controls, refs, agentVisible, hotkeysEnabled } =
    args;
  const onSend = useAgentSendHandler({ featureId, projectId, data, controls });
  const hasAccessModes = controls.providerAccessModes.length > 0;
  return useMemo(
    () => ({
      label: "Agent",
      Icon: BotIcon,
      shortcut: ["cmd", "shift", "A"],
      content: <AgentTabContent args={args} onSend={onSend} hasAccessModes={hasAccessModes} />,
    }),
    [
      agentVisible,
      args,
      controls,
      data,
      featureId,
      hotkeysEnabled,
      hasAccessModes,
      onSend,
      projectId,
      refs.agent,
      sessionId,
    ],
  );
}

function useAgentSendHandler(args: {
  featureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
}): (
  text: string,
  attachments?: PromptAttachmentPayload[],
  claudeProfile?: string,
) => Promise<void> {
  const { featureId, projectId, data, controls } = args;
  const queryClient = useQueryClient();
  const setFeatureSetting = useSetFeatureSetting();
  const checkoutMutateAsync = useCheckoutBranch().mutateAsync;
  return useCallback(
    async (text, attachments, claudeProfile) => {
      if (text.trim() === "/clear") {
        controls.ws.clearSession();
        return;
      }
      if (text.trim() === "/compact" && COMPACT_ACTION_PROVIDERS.has(controls.activeProviderId)) {
        controls.ws.compactSession();
        return;
      }
      const isFirstPrompt = (data.session?.blocks?.length ?? 0) === 0;
      const choice = resolveWorktreeChoice({
        mode: controls.worktreeMode,
        selectedBranch: controls.selectedBranch,
        defaultBranch: data.defaultBranch,
      });
      // First-prompt branch provisioning the backend acts on *after* auto-naming
      // (so the new branch carries the feature's name). `undefined` = no setup.
      let branchSetup: FirstPromptBranchSetup | undefined;
      if (isFirstPrompt) {
        if (choice.backendMode === "skip") {
          // "On branch": run in the project folder, switching to the picked
          // branch first when it differs from the current one.
          if (choice.checkout != null) {
            const ok = await checkoutSelectedBranch({
              branch: choice.checkout,
              projectId,
              featureId,
              queryClient,
              checkoutMutateAsync,
            });
            if (!ok) return;
          }
        } else if (choice.backendMode === "project_branch") {
          // "From branch": the backend forks a project-path branch named after
          // the feature once it has auto-named — no worktree, no pre-send git op.
          branchSetup = { kind: "project_branch", base: choice.base };
        } else {
          // Worktree-provisioning modes persist their settings before send so
          // the backend's `ensure_worktree` reads them. A failure throws + aborts.
          await saveWorktreeChoice({ choice, featureId, setFeatureSetting });
          branchSetup = { kind: "worktree" };
        }
      }
      controls.ws.sendPrompt(text, {
        attachments,
        branchSetup,
        claudeProfile: claudeProfile ?? claudeProfileForPrompt(controls),
      });
    },
    [
      checkoutMutateAsync,
      controls.activeProviderId,
      controls.claudeProfile.selectedClaudeProfile,
      controls.selectedBranch,
      controls.worktreeMode,
      controls.ws,
      data.defaultBranch,
      data.session?.blocks?.length,
      featureId,
      projectId,
      queryClient,
      setFeatureSetting,
    ],
  );
}

export function handleModelChange(
  nextProviderId: string,
  modelId: string,
  controls: ReturnType<typeof useSessionControls>,
): void {
  // `provider.set` is rejected once the session is active, so it is reserved
  // for cross-provider picks that genuinely need the atomic switch. A plain
  // model change on the same provider goes through `model.set`, which stays
  // legal mid-conversation.
  const currentProviderId = controls.ws.currentSelection?.providerId;
  if (currentProviderId !== undefined && currentProviderId === nextProviderId) {
    controls.ws.setModel(modelId, nextProviderId);
  } else {
    controls.ws.setProvider(nextProviderId, modelId);
  }

  const nextModel = controls.agentCatalog.data?.providers
    .find((provider) => provider.id === nextProviderId)
    ?.models.find((model) => model.id === modelId);
  const nextLevels = supportedThinkingEffortLevels(nextModel);
  const nextEffort = controls.resolveModelThinkingEffort(nextProviderId, modelId);
  if (nextEffort) {
    controls.ws.setThinkingEffort(nextEffort);
  } else if (!nextLevels.includes(controls.ws.currentThinkingEffort as never)) {
    controls.ws.setThinkingEffort(undefined);
  }
}
