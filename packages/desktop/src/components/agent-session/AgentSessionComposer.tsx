import { memo, useCallback, useMemo, type RefObject, type ReactElement } from "react";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import { normalizeContextWindow } from "@/types/agent";
import { AgentPromptBar, type AgentPromptBarHandle } from "../AgentPromptBar";
import { ContextUsageBar } from "../ContextUsageBar";
import type { AgentSessionProps } from "./types";
import { MetaBar, type MetaBarHandle } from "./MetaBar";
import { MetaBarSecondary } from "./MetaBarSecondary";
import { useSessionSchedules } from "./SessionSchedules";

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
  models: AgentSessionMetaProps["models"];
  providers: AgentSessionMetaProps["providers"];
  canChangeProvider: boolean;
  supportedThinkingEfforts: AgentSessionMetaProps["supportedThinkingEfforts"];
  supportsFastMode: boolean;
  isFastModePending: boolean;
  onFastModeChange: (enabled: boolean) => Promise<void>;
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

// Unified-grid cards are inline rather than screen-bottom, so they opt out of
// all the viewport-fitting below.
const COLLAPSIBLE_ROOT_CLASS = "shrink-0";

// Full-page sessions must stay INSIDE the frame. This row used to be `shrink-0`,
// which let the composer grow straight past the bottom of the screen: the
// transcript above it is `flex-1 min-h-0` but bottoms out at its own 48px of
// vertical padding, so once the composer got tall — a long draft with the
// keyboard open — nothing could absorb the excess and the send button plus the
// rows beneath it fell off-screen unreachable. Dropping `shrink-0` hands the
// overflow here instead; the transcript's `flex-basis: 0` means it still can't
// squeeze the composer in the normal case, since free space goes to the
// transcript by `grow` and shrinking only starts once the composer alone
// exceeds the frame.
//
// `flex flex-col` then passes that squeeze down: the prompt bar is the only row
// with `min-h-0`, so it absorbs the whole deficit and the editable inside it
// scrolls rather than shoving the send button off-screen. Without this the
// composer stayed a block box, grew past the frame on a ~6-line draft, and
// `overflow-y-auto` merely parked the overflow in a top-anchored scroll area —
// reachable, but only if you thought to scroll the composer. That scroll stays
// as a backstop for chrome that can't shrink at all; it should no longer engage.
//
// The home-indicator clearance sits on this root so it applies whichever
// optional row happens to be last. It used to hang off `ComposerContextUsage`,
// which returns null until a session reports context usage — so before the
// first prompt the bottom chips sat flush against the screen edge.
const FULL_PAGE_ROOT_CLASS =
  "flex min-h-0 flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)]";

// Bottom safe-area clearance lives on the composer root (see above), so this row
// only owns its own spacing — the same in both layouts.
const CONTEXT_USAGE_CLASS = "flex items-center gap-2 px-3 pb-1.5 pt-0";

export const AgentSessionComposer = memo(function AgentSessionComposer(
  props: AgentSessionComposerProps,
): ReactElement {
  const { contextUsage } = props.sessionProps;
  const schedules = useSessionSchedules(props.sessionProps.featureId, props.sessionProps.projectId);
  // A schedule banner above the chips reads better with the tighter row, so the
  // bar drops to its standalone padding.
  const scheduledActive = props.shouldShowPromptBar && schedules.armed.length > 0;
  const metaBar = props.hasMeta ? (
    <AgentSessionMeta {...props} metaVariant={scheduledActive ? "standalone" : "session"} />
  ) : null;
  const promptBar = props.shouldShowPromptBar ? (
    <AgentSessionPrompt {...props} onScheduleRequest={schedules.requestSchedule} />
  ) : null;
  const secondaryBar =
    props.isNarrow && props.hasSecondaryMeta && props.shouldShowPromptBar ? (
      <AgentSessionSecondary {...props} />
    ) : null;

  return (
    <div className={props.collapsible ? COLLAPSIBLE_ROOT_CLASS : FULL_PAGE_ROOT_CLASS}>
      {props.shouldShowPromptBar && schedules.element}
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
      providerAccessModes={session.providerAccessModes}
      accessMode={session.accessMode}
      accessModeDefault={session.accessModeDefault}
      isAccessModePending={session.isAccessModePending}
      onAccessModeChange={session.onAccessModeChange}
      showWorktreeChip={props.showWorktreeChip}
      worktreeMode={session.worktreeMode}
      onWorktreeModeChange={session.onWorktreeModeChange}
      worktreeProjectId={session.worktreeProjectId}
      worktreeDefaultBranch={session.worktreeDefaultBranch}
      worktreeProjectPath={session.worktreeProjectPath}
      worktreeSelectedBranch={session.worktreeSelectedBranch}
      onWorktreeBranchChange={session.onWorktreeBranchChange}
      onProviderChange={session.onProviderChange}
      onModelChange={session.onModelChange}
      currentThinkingEffort={parseThinkingEffort(session.currentThinkingEffort)}
      supportedThinkingEfforts={props.supportedThinkingEfforts}
      onThinkingEffortChange={session.onThinkingEffortChange}
      supportsFastMode={props.supportsFastMode}
      fastMode={session.fastMode ?? false}
      isFastModePending={props.isFastModePending}
      onFastModeChange={props.onFastModeChange}
      showClaudeProfileSelector={props.showClaudeProfileSelector}
      claudeProfile={props.claudeProfile}
      claudeProfiles={props.claudeProfiles}
      claudeProfilesLoading={props.claudeProfilesLoading}
      claudeProfilesError={props.claudeProfilesError}
      onClaudeProfileChange={props.onClaudeProfileChange}
      showReadOnlyModel={session.showReadOnlyModel}
      currentSelection={session.selection ?? null}
      models={props.models}
      providers={props.providers}
      canChangeProvider={props.canChangeProvider}
      todos={session.todos}
      runtimeSessionId={session.runtimeSessionId}
      featureId={session.featureId}
      wsSessionId={session.wsSessionId}
      projectPath={props.projectPath}
      isRunning={session.status === "agent"}
      onPause={session.onStop}
      onModelSelected={() => props.promptBarRef.current?.focusInput()}
      sessionConfigControls={session.sessionConfigControls}
    />
  );
}

function AgentSessionPrompt(
  props: AgentSessionComposerProps & {
    onScheduleRequest?: (prompt: string, onSaved: () => void) => void;
  },
): ReactElement {
  const session = props.sessionProps;
  const selectReferencedWorktree = useCallback(
    (branch: string): void => {
      session.onWorktreeBranchChange?.(branch);
      session.onWorktreeModeChange?.("branch_worktree");
    },
    [session.onWorktreeBranchChange, session.onWorktreeModeChange],
  );
  const referencedWorktreeSelection = useMemo(
    () =>
      session.blocks.length === 0 &&
      session.worktreeMode != null &&
      session.onWorktreeBranchChange &&
      session.onWorktreeModeChange
        ? {
            mode: session.worktreeMode,
            selectedBranch: session.worktreeSelectedBranch ?? null,
            onSelect: selectReferencedWorktree,
          }
        : undefined,
    [
      selectReferencedWorktree,
      session.blocks.length,
      session.onWorktreeBranchChange,
      session.onWorktreeModeChange,
      session.worktreeMode,
      session.worktreeSelectedBranch,
    ],
  );
  return (
    <AgentPromptBar
      ref={props.promptBarRef}
      onSend={props.onSend}
      onScheduleRequest={props.onScheduleRequest}
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
      promptCommandPolicy={session.promptCommandPolicy}
      pendingPermission={session.pendingPermission}
      referencedWorktreeSelection={referencedWorktreeSelection}
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
    <div className={CONTEXT_USAGE_CLASS}>
      <ContextUsageBar
        usage={contextUsage}
        className="flex-1 px-0 py-0"
        isStreaming={isAgentWorking}
      />
    </div>
  );
}
