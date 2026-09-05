import { useMemo, type ReactElement } from "react";
import { AgentSession } from "@/components/agent-session";
import { SessionInfoMcpServersProvider } from "@/components/agent-session/SessionInfoChip";
import type {
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type { SessionConfigControls } from "@/components/agent-session/types";

interface SessionAgentTabProps {
  sessionId: string;
  featureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  agentRef: ReturnType<typeof useSessionRefs>["agent"];
  agentVisible: boolean;
  hotkeysEnabled: boolean;
  hasAccessModes: boolean;
  onSend: (
    text: string,
    attachments?: PromptAttachmentPayload[],
    claudeProfile?: string,
  ) => Promise<void>;
}

function handleModelChange(
  nextProviderId: string,
  modelId: string,
  controls: ReturnType<typeof useSessionControls>,
): void {
  if (modelId !== controls.ws.currentModelId || nextProviderId !== controls.ws.currentProviderId) {
    controls.ws.setModel(modelId, nextProviderId);
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

export function SessionAgentTab({
  sessionId,
  featureId,
  projectId,
  data,
  controls,
  agentRef,
  agentVisible,
  hotkeysEnabled,
  hasAccessModes,
  onSend,
}: SessionAgentTabProps): ReactElement {
  const sessionConfigControls = useSessionConfigControls(controls);
  return (
    <SessionInfoMcpServersProvider mcpServers={controls.ws.mcpServers}>
      <AgentSession
        ref={agentRef}
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
        currentProviderId={controls.ws.currentProviderId}
        onProviderChange={controls.ws.setProvider}
        currentModelId={controls.ws.currentModelId}
        onModelChange={(nextProviderId, modelId) =>
          handleModelChange(nextProviderId, modelId, controls)
        }
        currentThinkingEffort={controls.ws.currentThinkingEffort}
        onThinkingEffortChange={controls.ws.setThinkingEffort}
        fastMode={controls.ws.fastMode}
        onFastModeChange={controls.ws.setFastMode}
        runtimeProvider={controls.ws.runtimeProvider}
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
