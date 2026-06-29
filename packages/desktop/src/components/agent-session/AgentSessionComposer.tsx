import { memo, type RefObject, type ReactElement } from "react";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import { normalizeContextWindow } from "@/types/agent";
import { AgentPromptBar, type AgentPromptBarHandle } from "../AgentPromptBar";
import { ContextUsageBar } from "../ContextUsageBar";
import { useScheduledMessage } from "@/hooks/useScheduledMessage";
import type { AgentSessionProps } from "./types";
import { MetaBar, type MetaBarHandle } from "./MetaBar";
import { MetaBarSecondary } from "./MetaBarSecondary";
import { SessionScheduledCard } from "./SessionScheduledCard";

export interface AgentSessionComposerProps {
  sessionProps: AgentSessionProps;
  promptBarRef: RefObject<AgentPromptBarHandle | null>;
  metaBarRef: RefObject<MetaBarHandle | null>;
  onSend: AgentSessionProps["onSend"];
  onCollapse: () => void;
  onToggleAutoScroll: () => void;
  shouldShowPromptBar: boolean;
  hasMeta: boolean;
  isNarrow: boolean;
  hasSecondaryMeta: boolean;
  showAutoScrollChip: boolean;
  autoScrollEnabled: boolean;
  showWorktreeChip: boolean;
  activeProviderId: string;
  currentModelLabel: string;
  isModelCatalogLoading: boolean;
  models: AgentSessionMetaProps["models"];
  providers: AgentSessionMetaProps["providers"];
  canChangeProvider: boolean;
  supportedThinkingEfforts: AgentSessionMetaProps["supportedThinkingEfforts"];
  projectPath: string | undefined;
  isAgentWorking: boolean;
  agentTabActive: boolean;
  collapsible: boolean;
  showClaudeProfileSelector: boolean;
  claudeProfile: string;
  claudeProfiles: AgentSessionMetaProps["claudeProfiles"];
  claudeProfilesLoading: boolean;
  claudeProfilesError: boolean;
  onClaudeProfileChange: (profile: string) => void;
}

type AgentSessionMetaProps = Parameters<typeof MetaBar>[0];

export const AgentSessionComposer = memo(function AgentSessionComposer(
  props: AgentSessionComposerProps,
): ReactElement {
  const { contextUsage } = props.sessionProps;
  const schedule = useScheduledMessage(props.sessionProps.featureId);
  // When the scheduled-message banner sits above the chips, the meta bar's
  // "blend into the conversation" fade (negative margin + gradient) would
  // overpaint the banner. Drop it to a standalone bar so the banner reads as a
  // clean row above the chips.
  const scheduledActive = props.shouldShowPromptBar && schedule.scheduled != null;
  const metaBar = props.hasMeta ? (
    <AgentSessionMeta {...props} metaVariant={scheduledActive ? "standalone" : "session"} />
  ) : null;
  const promptBar = props.shouldShowPromptBar ? (
    <AgentSessionPrompt {...props} onSchedule={schedule.schedule} />
  ) : null;
  const secondaryBar =
    props.isNarrow && props.hasSecondaryMeta && props.shouldShowPromptBar ? (
      <AgentSessionSecondary {...props} />
    ) : null;

  return (
    <div className="shrink-0">
      {props.collapsible && !props.hasMeta && <ComposerFade />}
      {props.shouldShowPromptBar && (
        <SessionScheduledCard schedule={schedule} onSend={props.onSend} />
      )}
      {metaBar}
      {promptBar}
      {secondaryBar}
      <ComposerContextUsage
        contextUsage={contextUsage}
        isAgentWorking={props.isAgentWorking}
        collapsible={props.collapsible}
      />
    </div>
  );
});

function AgentSessionMeta(
  props: AgentSessionComposerProps & { metaVariant: "session" | "standalone" },
): ReactElement {
  const session = props.sessionProps;
  return (
    <MetaBar
      ref={props.metaBarRef}
      variant={props.metaVariant}
      secondaryBelow={props.isNarrow}
      showAutoScrollChip={props.showAutoScrollChip}
      autoScrollEnabled={props.autoScrollEnabled}
      onToggleAutoScroll={props.onToggleAutoScroll}
      permissionMode={session.permissionMode}
      onPermissionModeToggle={session.onPermissionModeToggle}
      enabledOptInModes={session.enabledOptInModes}
      providerModes={session.providerModes}
      codexPermissionMode={session.codexPermissionMode}
      codexPermissionDefaultMode={session.codexPermissionDefaultMode}
      isCodexPermissionModePending={session.isCodexPermissionModePending}
      onCodexPermissionModeChange={session.onCodexPermissionModeChange}
      showWorktreeChip={props.showWorktreeChip}
      worktreeMode={session.worktreeMode}
      onWorktreeModeChange={session.onWorktreeModeChange}
      worktreeProjectId={session.worktreeProjectId}
      worktreeDefaultBranch={session.worktreeDefaultBranch}
      worktreeProjectPath={session.worktreeProjectPath}
      worktreeSelectedBranch={session.worktreeSelectedBranch}
      onWorktreeBranchChange={session.onWorktreeBranchChange}
      onProviderChange={session.onProviderChange}
      currentProviderId={props.activeProviderId}
      onModelChange={session.onModelChange}
      currentThinkingEffort={parseThinkingEffort(session.currentThinkingEffort)}
      supportedThinkingEfforts={props.supportedThinkingEfforts}
      onThinkingEffortChange={session.onThinkingEffortChange}
      showClaudeProfileSelector={props.showClaudeProfileSelector}
      claudeProfile={props.claudeProfile}
      claudeProfiles={props.claudeProfiles}
      claudeProfilesLoading={props.claudeProfilesLoading}
      claudeProfilesError={props.claudeProfilesError}
      onClaudeProfileChange={props.onClaudeProfileChange}
      showReadOnlyModel={session.showReadOnlyModel}
      currentModelId={session.currentModelId}
      currentModelLabel={props.currentModelLabel}
      isModelCatalogLoading={props.isModelCatalogLoading}
      models={props.models}
      providers={props.providers}
      canChangeProvider={props.canChangeProvider}
      todos={session.todos}
      runtimeProvider={session.runtimeProvider}
      runtimeSessionId={session.runtimeSessionId}
      featureId={session.featureId}
      wsSessionId={session.wsSessionId}
      projectPath={props.projectPath}
      isRunning={session.status === "agent"}
      onPause={session.onStop}
      onModelSelected={() => props.promptBarRef.current?.focusInput()}
    />
  );
}

function AgentSessionPrompt(
  props: AgentSessionComposerProps & {
    onSchedule?: (message: string, scheduledAt: Date) => Promise<void>;
  },
): ReactElement {
  const session = props.sessionProps;
  return (
    <AgentPromptBar
      ref={props.promptBarRef}
      onSend={props.onSend}
      onSchedule={props.onSchedule}
      onStop={session.onStop}
      status={session.status}
      disabled={session.disabled}
      pendingQuestions={session.pendingQuestions}
      onQuestionResponse={session.onAnswerSubmit}
      disableShortcuts={session.disableShortcuts}
      onCollapse={props.collapsible ? props.onCollapse : undefined}
      permissionMode={session.permissionMode}
      onPermissionModeToggle={session.onPermissionModeToggle}
      pendingPlanApproval={session.pendingPlanApproval}
      planApproveLabel={session.planApproveLabel}
      planApprovalError={session.planApprovalError}
      onPlanApprove={session.onPlanApprove}
      onPlanRequestChanges={session.onPlanRequestChanges}
      onPlanReject={session.onPlanReject}
      onGateClose={session.onGateClose}
      onOpenModelPicker={
        session.onModelChange ? () => props.metaBarRef.current?.openModelPicker() : undefined
      }
      agentTabActive={props.agentTabActive}
      featureId={session.featureId}
      projectId={session.projectId}
      sessionId={session.sessionId}
      wsSessionId={session.wsSessionId}
      providerId={props.activeProviderId}
      onToggleMaximize={session.onToggleMaximize}
      noTopPadding={props.hasMeta}
      slashCommandsOverride={session.slashCommandsOverride}
      slashCommandsLoading={session.slashCommandsLoading}
      pendingPermission={session.pendingPermission}
      onPermissionDecision={session.onPermissionDecision}
      isSubmittingPermission={session.isSubmittingPermission}
    />
  );
}

function AgentSessionSecondary(props: AgentSessionComposerProps): ReactElement {
  const session = props.sessionProps;
  return (
    <MetaBarSecondary
      showWorktreeChip={props.showWorktreeChip}
      worktreeMode={session.worktreeMode}
      onWorktreeModeChange={session.onWorktreeModeChange}
      worktreeProjectId={session.worktreeProjectId}
      worktreeDefaultBranch={session.worktreeDefaultBranch}
      worktreeProjectPath={session.worktreeProjectPath}
      worktreeSelectedBranch={session.worktreeSelectedBranch}
      onWorktreeBranchChange={session.onWorktreeBranchChange}
      showAutoScrollChip={props.showAutoScrollChip}
      autoScrollEnabled={props.autoScrollEnabled}
      onToggleAutoScroll={props.onToggleAutoScroll}
      todos={session.todos}
      runtimeProvider={session.runtimeProvider}
      runtimeSessionId={session.runtimeSessionId}
      featureId={session.featureId}
      wsSessionId={session.wsSessionId}
      projectPath={props.projectPath}
      isRunning={session.status === "agent"}
      onPause={session.onStop}
      claudeProfile={props.claudeProfile}
      claudeProfiles={props.claudeProfiles}
      claudeProfilesLoading={props.claudeProfilesLoading}
      claudeProfilesError={props.claudeProfilesError}
      onClaudeProfileChange={props.onClaudeProfileChange}
    />
  );
}

function ComposerFade(): ReactElement {
  return (
    <div
      className="pointer-events-none h-16 -mt-16"
      style={{
        background:
          "linear-gradient(to bottom, transparent 0%, hsl(var(--background) / 0.7) 8%, hsl(var(--background) / 0.9) 20%, hsl(var(--background)) 40%)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        maskImage: "linear-gradient(to bottom, transparent 0%, black 25%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 25%)",
      }}
    />
  );
}

function ComposerContextUsage({
  contextUsage,
  isAgentWorking,
  collapsible,
}: {
  contextUsage: AgentSessionProps["contextUsage"];
  isAgentWorking: boolean;
  collapsible: boolean;
}) {
  const shouldShow = collapsible
    ? !!contextUsage
    : normalizeContextWindow(contextUsage?.contextWindow) != null;
  if (!contextUsage || !shouldShow) return null;

  return (
    <div className={contextUsageClassName(collapsible)}>
      <ContextUsageBar
        usage={contextUsage}
        className="flex-1 px-0 py-0"
        isStreaming={isAgentWorking}
      />
    </div>
  );
}

function contextUsageClassName(collapsible: boolean): string {
  if (collapsible) return "flex items-center gap-2 px-3 pb-1.5 pt-0";
  return "flex items-center gap-2 px-3 pt-0 pb-[max(0.375rem,env(safe-area-inset-bottom))]";
}
