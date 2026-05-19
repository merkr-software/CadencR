import { lazy, Suspense, useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BotIcon, CodeIcon, GitCompareArrowsIcon, TerminalIcon } from "lucide-react";
import { AgentSession } from "@/components/agent-session";
import { resolveWorktreeChoice } from "@/components/agent-session/WorktreePopover";
import { FeatureGitTab } from "@/components/FeatureGitTab";
import { FeatureTerminalTab } from "@/components/FeatureTerminalTab";
import { GitBadge } from "@/components/feature-layout/GitBadge";
import type { FeatureTabDef, FeatureTabs } from "@/components/feature-layout/types";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import {
  getGetBranchQueryKey,
  getGetGitStatusQueryKey,
  getListBranchesQueryKey,
  listBranches,
  useCheckoutBranch,
  useSetFeatureSetting,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import type {
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";

const FeatureEditorTab = lazy(() => import("@/components/editor/FeatureEditorTab"));
const COMPACT_ACTION_PROVIDERS = new Set(["opencode", "codex_cli"]);

interface UseSessionTabsArgs {
  sessionId: string;
  featureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
  agentVisible: boolean;
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
}

export function useSessionTabs(args: UseSessionTabsArgs): FeatureTabs {
  const agentTab = useAgentTab(args);
  const terminalTab = useTerminalTab(args);
  const gitTab = useGitTab(args);
  const editorTab = useEditorTab(args);
  return useMemo(
    () => ({
      agent: agentTab,
      terminal: terminalTab,
      git: gitTab,
      editor: editorTab,
    }),
    [agentTab, editorTab, gitTab, terminalTab],
  );
}

function useAgentTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { sessionId, featureId, projectId, data, controls, refs, agentVisible, hotkeysEnabled } =
    args;
  // Always thread the real feature/project IDs through `AgentSession`. They
  // drive feature-scoped queries (working-directory lookup for basePath path
  // trimming, file list autocomplete) that must run for every mounted agent,
  // not just the focused one — otherwise the unified grid shows full
  // absolute paths in tool calls for any agent that isn't currently active.
  // Hotkey gating is handled separately via `disableShortcuts` and
  // `agentTabActive` below; the IDs themselves don't need to be nulled.
  const onSend = useAgentSendHandler({ featureId, projectId, data, controls });
  return useMemo(
    () => ({
      label: "Agent",
      Icon: BotIcon,
      shortcut: ["cmd", "shift", "A"],
      content: (
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
          lifecycle={controls.ws.lifecycle}
          turnTiming={controls.ws.turnTiming}
          onSend={onSend}
          onStop={controls.ws.interrupt}
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
          runtimeProvider={controls.ws.runtimeProvider}
          runtimeSessionId={controls.ws.runtimeSessionId || undefined}
          slashCommandsOverride={data.session?.slashCommands ?? []}
          slashCommandsLoading={data.session?.slashCommandsLoading ?? false}
          todos={agentVisible ? (data.session?.todos ?? null) : null}
          disableShortcuts={!hotkeysEnabled}
          agentTabActive={agentVisible && hotkeysEnabled}
          hasMore={controls.ws.hasMore}
          onLoadOlder={controls.ws.loadOlderMessages}
          useWorktree={controls.useWorktree}
          onToggleWorktree={controls.toggleWorktree}
          worktreeProjectId={projectId}
          worktreeDefaultBranch={data.defaultBranch}
          worktreeSelectedBranch={controls.selectedBranch}
          onWorktreeBranchChange={controls.setSelectedBranch}
          className="h-full"
        />
      ),
    }),
    [
      agentVisible,
      controls,
      data,
      featureId,
      hotkeysEnabled,
      onSend,
      projectId,
      refs.agent,
      sessionId,
    ],
  );
}

function useTerminalTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, refs } = args;
  return useMemo(
    () => ({
      label: "Terminal",
      Icon: TerminalIcon,
      shortcut: ["cmd", "shift", "T"],
      content: (
        <FeatureTerminalTab ref={refs.terminal} featureId={featureId} projectId={projectId} />
      ),
    }),
    [featureId, projectId, refs.terminal],
  );
}

function useGitTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, data, sendFromGitTab } = args;
  return useMemo(
    () => ({
      label: "Git",
      Icon: GitCompareArrowsIcon,
      shortcut: ["cmd", "shift", "G"],
      badge: <GitBadge featureId={featureId} gitBranch={data.gitBranch} />,
      content: (
        <FeatureGitTab featureId={featureId} diffMode="worktree" onSendComments={sendFromGitTab} />
      ),
    }),
    [data.gitBranch, featureId, sendFromGitTab],
  );
}

function useEditorTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, data, refs } = args;
  const projectPathOrCwd = data.effectiveCwd ?? data.projectPath;
  return useMemo(
    () => ({
      label: "Editor",
      Icon: CodeIcon,
      shortcut: ["cmd", "shift", "E"],
      content: projectPathOrCwd ? (
        <Suspense fallback={null}>
          <FeatureEditorTab
            ref={refs.editor}
            featureId={featureId}
            projectId={projectId}
            projectPath={projectPathOrCwd}
          />
        </Suspense>
      ) : null,
    }),
    [featureId, projectId, projectPathOrCwd, refs.editor],
  );
}

function useAgentSendHandler(args: {
  featureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
}): (text: string, images?: Array<{ base64: string; mimeType: string }>) => Promise<void> {
  const { featureId, projectId, data, controls } = args;
  const queryClient = useQueryClient();
  const setFeatureSetting = useSetFeatureSetting();
  // Pull the stable `mutateAsync` out of the mutation result so the callback
  // identity isn't churned every time react-query re-renders the host.
  const checkoutMutateAsync = useCheckoutBranch().mutateAsync;
  return useCallback(
    async (text, images) => {
      if (text.trim() === "/clear") {
        controls.ws.clearSession();
        return;
      }
      if (text.trim() === "/compact" && COMPACT_ACTION_PROVIDERS.has(controls.activeProviderId)) {
        controls.ws.compactSession();
        return;
      }
      const isFirstPrompt = (data.session?.blocks?.length ?? 0) === 0;
      const branches = await loadBranchesForFirstPrompt({
        isFirstPrompt,
        projectId,
        queryClient,
        selectedBranch: controls.selectedBranch,
      });
      const choice = resolveWorktreeChoice({
        useWorktree: controls.useWorktree,
        selectedBranch: controls.selectedBranch,
        branches,
      });
      if (isFirstPrompt && choice.kind !== "off") {
        await saveWorktreeChoice({ choice, featureId, setFeatureSetting });
      }
      // Authoritative checkout for the no-worktree branch pick. Failure
      // surfaces the verbatim git stderr and aborts the send.
      if (
        isFirstPrompt &&
        choice.kind === "off" &&
        controls.selectedBranch != null &&
        controls.selectedBranch !== data.defaultBranch
      ) {
        try {
          await checkoutMutateAsync({
            data: { project_id: projectId, branch: controls.selectedBranch },
          });
          queryClient.invalidateQueries({
            queryKey: getGetBranchQueryKey({ project_id: projectId }),
          });
          queryClient.invalidateQueries({
            queryKey: getListBranchesQueryKey({ project_id: projectId }),
          });
          queryClient.invalidateQueries({
            queryKey: getGetGitStatusQueryKey({ feature_id: featureId }),
          });
        } catch (err) {
          toast.error(apiErrorMessage(err, "git checkout failed"));
          return;
        }
      }
      const shouldStartWorktree = isFirstPrompt && choice.kind !== "off";
      controls.ws.sendPrompt(text, images, shouldStartWorktree ? true : undefined);
    },
    [
      checkoutMutateAsync,
      controls.activeProviderId,
      controls.selectedBranch,
      controls.useWorktree,
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

interface LoadBranchesParams {
  isFirstPrompt: boolean;
  projectId: number;
  queryClient: QueryClient;
  selectedBranch: string | null;
}

async function loadBranchesForFirstPrompt(
  params: LoadBranchesParams,
): Promise<Awaited<ReturnType<typeof listBranches>> | undefined> {
  const { isFirstPrompt, projectId, queryClient, selectedBranch } = params;
  if (!isFirstPrompt || selectedBranch == null) return undefined;
  try {
    return await queryClient.ensureQueryData({
      queryKey: getListBranchesQueryKey({ project_id: projectId }),
      queryFn: ({ signal }) => listBranches({ project_id: projectId }, signal),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    toast.error(`Could not load branches: ${message}`);
    throw err;
  }
}

type WorktreeChoice = ReturnType<typeof resolveWorktreeChoice>;

async function saveWorktreeChoice(params: {
  choice: WorktreeChoice;
  featureId: number;
  setFeatureSetting: ReturnType<typeof useSetFeatureSetting>;
}): Promise<void> {
  const { choice, featureId, setFeatureSetting } = params;
  try {
    if (choice.kind === "reuse") {
      await setFeatureSetting.mutateAsync({
        id: featureId,
        data: { key: "worktree_reuse_branch", value: choice.branch },
      });
    } else if (choice.kind === "new" && choice.base) {
      await setFeatureSetting.mutateAsync({
        id: featureId,
        data: { key: "worktree_base_branch", value: choice.base },
      });
    }
    await setFeatureSetting.mutateAsync({
      id: featureId,
      data: { key: "worktree_mode", value: choice.kind },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    toast.error(`Could not save worktree settings: ${message}`);
    throw err;
  }
}

function handleModelChange(
  nextProviderId: string,
  modelId: string,
  controls: ReturnType<typeof useSessionControls>,
): void {
  if (modelId !== controls.ws.currentModelId) controls.ws.setModel(modelId);
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
