import { useCallback, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon } from "lucide-react";
import { AgentSession } from "@/components/agent-session";
import { SessionInfoMcpServersProvider } from "@/components/agent-session/SessionInfoChip";
import { resolveWorktreeChoice } from "@/lib/worktree-mode";
import { toastError } from "@/lib/api-errors";
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
import { isCompactActionPrompt } from "@/lib/provider-host-capabilities";
import type { UseSessionTabsArgs } from "./WebSocketSessionFeatureBlockTabs";

import type { AgentSessionProps, SessionConfigControls } from "./agent-session/types";

type SessionControls = ReturnType<typeof useSessionControls>;
const NO_SLASH_COMMANDS: NonNullable<AgentSessionProps["slashCommandsOverride"]> = [];

/**
 * The latest value, read at call time. `controls.ws` is a snapshot rebuilt on
 * every stream delta; callbacks that close over it change identity per delta
 * and re-render the composer with each one.
 */
function useLatestRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Composer callbacks that keep their identity across stream deltas. */
function useStableSessionCallbacks(controls: SessionControls) {
  const latest = useLatestRef(controls);
  return useMemo(
    () => ({
      onPermissionDecision: (
        decision: Parameters<NonNullable<AgentSessionProps["onPermissionDecision"]>>[0],
        feedback?: string,
        optionId?: string,
      ): void => {
        const { ws } = latest.current;
        ws.respondToPermission(ws.pendingRequestId, decision, feedback, optionId);
      },
      onGateClose: (): void => latest.current.ws.closeGate("escape"),
      onModelChange: (nextProviderId: string, modelId: string): void =>
        handleModelChange(nextProviderId, modelId, latest.current),
      onThinkingEffortChange: (effort: string | undefined): void =>
        setEffort(latest.current, effort),
      onFastModeChange: (enabled: boolean): Promise<void> => setFastMode(latest.current, enabled),
    }),
    [latest],
  );
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
  const callbacks = useStableSessionCallbacks(controls);
  return (
    <SessionInfoMcpServersProvider mcpServers={controls.ws.mcpServers}>
      <AgentSession
        ref={refs.agent}
        agentType="session"
        featureId={featureId}
        projectId={projectId}
        wsSessionId={sessionId}
        sessionId={controls.ws.sessionDbId ?? undefined}
        blocks={controls.ws.blocks}
        rootBlocks={controls.ws.rootBlocks}
        toolResultMap={controls.ws.toolResultMap}
        historyPrependDisplayOffset={controls.ws.historyPrependDisplayOffset}
        status={controls.ws.status}
        isCompacting={controls.ws.isCompacting}
        lifecycle={controls.ws.lifecycle}
        turnClock={controls.ws.turnClock}
        onSend={onSend}
        onStop={controls.ws.interrupt}
        disabled={hasAccessModes && controls.isAccessModePending}
        pendingPermission={controls.ws.pendingPermission}
        onPermissionDecision={callbacks.onPermissionDecision}
        isSubmittingPermission={controls.ws.isSubmittingPermission}
        pendingQuestions={
          controls.ws.pendingQuestions.length > 0 ? controls.ws.pendingQuestions : undefined
        }
        pendingQuestionRequestId={controls.ws.pendingRequestId}
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
        onPermissionModeSet={controls.handlePermissionModeSet}
        modelSupportsAutoMode={controls.modelSupportsAutoMode}
        steeringAcknowledged={controls.steeringAcknowledged}
        pendingPlanApproval={controls.ws.pendingPlanApproval}
        onPlanApprove={controls.ws.approvePlan}
        onPlanRequestChanges={controls.ws.requestPlanChanges}
        onGateClose={callbacks.onGateClose}
        contextUsage={controls.ws.contextUsage}
        selection={controls.ws.currentSelection}
        onProviderChange={controls.ws.setProvider}
        onModelChange={callbacks.onModelChange}
        currentThinkingEffort={controls.ws.currentThinkingEffort}
        onThinkingEffortChange={callbacks.onThinkingEffortChange}
        fastMode={controls.ws.fastMode}
        onFastModeChange={callbacks.onFastModeChange}
        runtimeProvider={controls.ws.currentSelection?.providerId}
        runtimeSessionId={controls.ws.runtimeSessionId || undefined}
        sessionConfigControls={sessionConfigControls}
        slashCommandsOverride={data.session?.slashCommands ?? NO_SLASH_COMMANDS}
        slashCommandsLoading={data.session?.slashCommandsLoading ?? false}
        slashCommandsError={data.session?.slashCommandsError ?? null}
        promptCommandPolicy={data.session?.promptCommandPolicy}
        todos={agentVisible ? (data.session?.todos ?? null) : null}
        disableShortcuts={!hotkeysEnabled}
        agentTabActive={agentVisible && hotkeysEnabled}
        claudeProfileSelection={controls.claudeProfile}
        hasMore={controls.ws.hasMore}
        onLoadOlder={controls.ws.loadOlderMessages}
        onLoadPromptTurn={controls.ws.loadPromptTurn}
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

function setEffort(controls: SessionControls, effort: string | undefined): void {
  if (controls.supportsConfigInheritance)
    void controls.ws
      .setRuntimeOverrides({ thinking_effort: effort ?? null })
      .catch((error) => toastError(error, "Could not update thinking effort"));
  else controls.ws.setThinkingEffort(effort);
}

function setFastMode(controls: SessionControls, enabled: boolean): Promise<void> {
  if (controls.supportsConfigInheritance) {
    return controls.ws.setRuntimeOverrides({ fast_mode: enabled });
  }
  return controls.ws.setFastMode(enabled);
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
      shortcutId: "pane-agent",
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
  const { featureId, projectId } = args;
  const queryClient = useQueryClient();
  const setFeatureSetting = useSetFeatureSetting();
  const checkoutMutateAsync = useCheckoutBranch().mutateAsync;
  // Read at send time: depending on `controls.ws` would rebuild this handler,
  // and so the composer's context, on every stream delta.
  const latest = useLatestRef(args);
  return useCallback(
    async (text, attachments, claudeProfile) => {
      const { data, controls } = latest.current;
      if (text.trim() === "/clear") {
        controls.ws.clearSession();
        return;
      }
      if (isCompactActionPrompt(text, controls.compactAction)) {
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
      // Awaiting delivery keeps the composer pending while the session
      // initializes; a rejection hands the text back to the composer.
      try {
        if (controls.ws.isCompacting && attachments?.length) {
          throw new Error("Keep attachments in the composer until compaction finishes.");
        }
        await controls.ws.deliverPrompt(text, {
          attachments,
          branchSetup,
          claudeProfile: claudeProfile ?? claudeProfileForPrompt(controls),
        });
      } catch (error) {
        toastError(error, "Message not sent");
        throw error;
      }
    },
    [checkoutMutateAsync, featureId, latest, projectId, queryClient, setFeatureSetting],
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
    if (controls.supportsConfigInheritance) {
      void controls.ws
        .setRuntimeOverrides({ model: modelId })
        .catch((error) => toastError(error, "Could not update model"));
    } else controls.ws.setModel(modelId, nextProviderId);
  } else {
    controls.ws.setProvider(nextProviderId, modelId);
  }

  // The thinking level is not sent from here: the backend resumes the target
  // model's last-used level (or its default) as part of the model/provider
  // change, so the client never guesses it.
}
