import { lazy, Suspense, useCallback, useMemo, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon, CodeIcon, GitCompareArrowsIcon, GlobeIcon, TerminalIcon } from "lucide-react";
import { AgentSession } from "@/components/agent-session";
import { SessionInfoMcpServersProvider } from "@/components/agent-session/SessionInfoChip";
import { resolveWorktreeChoice } from "@/lib/worktree-mode";
import { checkoutSelectedBranch, saveWorktreeChoice } from "@/components/worktree-send-helpers";
import type { FirstPromptBranchSetup } from "@/lib/ws-envelope";
import { FeatureGitTab } from "@/components/FeatureGitTab";
import { FeatureTerminalTab } from "@/components/FeatureTerminalTab";
import { GitBadge } from "@/components/feature-layout/GitBadge";
import type { FeatureTabDef, FeatureTabs } from "@/components/feature-layout/types";
import { supportedThinkingEffortLevels } from "@/shared/thinking-effort";
import { useCheckoutBranch, useSetFeatureSetting } from "@/api/generated";
import { PROVIDER_IDS } from "@/lib/providers";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type {
  useSessionControls,
  useSessionFeatureData,
  useSessionRefs,
} from "@/components/WebSocketSessionFeatureBlockHooks";
const FeatureEditorTab = lazy(() => import("@/components/editor/FeatureEditorTab"));
const BrowserWorkspaceTab = lazy(() =>
  import("@/components/BrowserWorkspaceTab").then((module) => ({
    default: module.BrowserWorkspaceTab,
  })),
);
const COMPACT_ACTION_PROVIDERS = new Set(["opencode", "codex_cli"]);
interface UseSessionTabsArgs {
  sessionId: string;
  featureId: number;
  // Scope that owns this block's layout + browser tabs. Equals `featureId` on
  // the feature route, but a distinct per-card id in the unified grid, so each
  // card's Browser stays isolated.
  layoutFeatureId: number;
  projectId: number;
  data: ReturnType<typeof useSessionFeatureData>;
  controls: ReturnType<typeof useSessionControls>;
  refs: ReturnType<typeof useSessionRefs>;
  agentVisible: boolean;
  nonAgentTabsEnabled: boolean;
  hotkeysEnabled: boolean;
  sendFromGitTab: (message: string) => void;
}

export function useSessionTabs(args: UseSessionTabsArgs): FeatureTabs {
  const agentTab = useAgentTab(args);
  const terminalTab = useTerminalTab(args);
  const gitTab = useGitTab(args);
  const editorTab = useEditorTab(args);
  const browserTab = useBrowserTab(args);
  return useMemo(
    () => ({
      agent: agentTab,
      terminal: terminalTab,
      git: gitTab,
      editor: editorTab,
      browser: browserTab,
    }),
    [agentTab, browserTab, editorTab, gitTab, terminalTab],
  );
}

function useAgentTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { sessionId, featureId, projectId, data, controls, refs, agentVisible, hotkeysEnabled } =
    args;
  const onSend = useAgentSendHandler({ featureId, projectId, data, controls });
  const isCodex = controls.activeProviderId === PROVIDER_IDS.CODEX_CLI;
  return useMemo(
    () => ({
      label: "Agent",
      Icon: BotIcon,
      shortcut: ["cmd", "shift", "A"],
      content: (
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
            disabled={isCodex && controls.isCodexPermissionModePending}
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
            codexPermissionMode={isCodex ? controls.codexPermissionMode : undefined}
            codexPermissionDefaultMode={isCodex ? controls.codexPermissionDefaultMode : undefined}
            isCodexPermissionModePending={isCodex ? controls.isCodexPermissionModePending : false}
            onCodexPermissionModeChange={
              isCodex ? controls.handleCodexPermissionModeChange : undefined
            }
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
      ),
    }),
    [
      agentVisible,
      controls,
      data,
      featureId,
      hotkeysEnabled,
      isCodex,
      onSend,
      projectId,
      refs.agent,
      sessionId,
    ],
  );
}

function useTerminalTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, refs, nonAgentTabsEnabled } = args;
  return useMemo(
    () => ({
      label: "Terminal",
      Icon: TerminalIcon,
      shortcut: ["cmd", "shift", "T"],
      content: nonAgentTabsEnabled ? (
        <FeatureTerminalTab ref={refs.terminal} featureId={featureId} projectId={projectId} />
      ) : (
        <DeferredTabContent label="Terminal" />
      ),
    }),
    [featureId, nonAgentTabsEnabled, projectId, refs.terminal],
  );
}

function useGitTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, data, nonAgentTabsEnabled, sendFromGitTab } = args;
  return useMemo(
    () => ({
      label: "Git",
      Icon: GitCompareArrowsIcon,
      shortcut: ["cmd", "shift", "G"],
      badge: <GitBadge featureId={featureId} gitBranch={data.gitBranch} />,
      content: nonAgentTabsEnabled ? (
        <FeatureGitTab featureId={featureId} diffMode="worktree" onSendComments={sendFromGitTab} />
      ) : (
        <DeferredTabContent label="Git" />
      ),
    }),
    [data.gitBranch, featureId, nonAgentTabsEnabled, sendFromGitTab],
  );
}

function useBrowserTab(args: UseSessionTabsArgs): FeatureTabDef {
  // Scope the Browser by the real featureId (not layoutFeatureId): the agent's
  // MCP is pinned to featureId, so its tabs are created in that scope. Using the
  // same id here is what makes agent-opened tabs appear in this panel.
  const { controls, nonAgentTabsEnabled, featureId } = args;
  const sendContext = useCallback(
    (message: string, images?: Array<{ base64: string; mimeType: string }>): void =>
      controls.ws.sendPrompt(message, {
        attachments: images?.map((image, index) => ({
          base64: image.base64,
          mimeType: image.mimeType,
          fileName: images.length > 1 ? `browser-context-${index + 1}.png` : "browser-context.png",
          kind: "image" as const,
        })),
        claudeProfile: claudeProfileForPrompt(controls),
      }),
    [controls],
  );
  return useMemo(
    () => ({
      label: "Browser",
      Icon: GlobeIcon,
      shortcut: ["cmd", "shift", "B"],
      content: nonAgentTabsEnabled ? (
        <Suspense fallback={null}>
          <BrowserWorkspaceTab scopeId={featureId} onSendContext={sendContext} />
        </Suspense>
      ) : (
        <DeferredTabContent label="Browser" />
      ),
    }),
    [featureId, nonAgentTabsEnabled, sendContext],
  );
}

function useEditorTab(args: UseSessionTabsArgs): FeatureTabDef {
  const { featureId, projectId, data, refs, nonAgentTabsEnabled } = args;
  const projectPathOrCwd = data.effectiveCwd ?? data.projectPath;
  return useMemo(
    () => ({
      label: "Editor",
      Icon: CodeIcon,
      shortcut: ["cmd", "shift", "E"],
      content: !nonAgentTabsEnabled ? (
        <DeferredTabContent label="Editor" />
      ) : projectPathOrCwd ? (
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
    [featureId, nonAgentTabsEnabled, projectId, projectPathOrCwd, refs.editor],
  );
}

function DeferredTabContent({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
      Loading {label} after the conversation…
    </div>
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

function claudeProfileForPrompt(
  controls: ReturnType<typeof useSessionControls>,
): string | undefined {
  return controls.activeProviderId === PROVIDER_IDS.CLAUDE_CODE
    ? controls.claudeProfile.selectedClaudeProfile
    : undefined;
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
