import { memo, useCallback, useMemo, type RefObject, type ReactElement } from "react";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import { contextUsageToShow } from "@/types/agent";
import { AgentPromptBar, type AgentPromptBarHandle } from "../AgentPromptBar";
import { ContextUsageBar } from "../ContextUsageBar";
import type { AgentSessionProps } from "./types";
import { MetaBar, type MetaBarHandle, type MetaBarSection } from "./MetaBar";
import { findProviderMode } from "@/lib/provider-modes";
import { useSessionSchedules } from "./SessionSchedules";
import { LaunchManifest } from "../composer/LaunchManifest";
import { AgentTodoList } from "../AgentTodoList";
import { AutoScrollChip } from "./AutoScrollChip";
import { useComposerSessionInfo } from "./ComposerSessionSlots";
import { SideConversations } from "../side-conversation/SideConversations";

export interface AgentSessionComposerProps {
  sessionProps: AgentSessionProps;
  promptBarRef: RefObject<AgentPromptBarHandle | null>;
  metaBarRef: RefObject<MetaBarHandle | null>;
  onSend: AgentSessionProps["onSend"];
  onCollapse: () => void;
  onToggleAutoScroll: () => void;
  shouldShowPromptBar: boolean;
  hasMeta: boolean;
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
  activeClaudeProfile: string;
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
// first prompt the bottom chips sat flush against the screen edge. It reads
// `--app-inset-bottom`, which drops to 0 while the on-screen keyboard is up.
//
// `overflow-y-auto` alone computes `overflow-x` to `auto` too, so anything
// poking past the card's sides (the running sweep did) let a sideways swipe
// scroll the whole composer out of its column. It only ever scrolls vertically.
const FULL_PAGE_ROOT_CLASS =
  "flex min-h-0 flex-col overflow-x-hidden overflow-y-auto pb-[var(--app-inset-bottom)]";

// Bottom safe-area clearance lives on the composer root (see above), so this row
// only owns its own spacing — the same in both layouts.
const CONTEXT_USAGE_CLASS = "flex items-center gap-2 px-3 pb-1.5 pt-0";

export const AgentSessionComposer = memo(function AgentSessionComposer(
  props: AgentSessionComposerProps,
): ReactElement {
  const { contextUsage } = props.sessionProps;
  const schedules = useSessionSchedules(props.sessionProps.featureId, props.sessionProps.projectId);
  const sessionInfo = useComposerSessionInfo(props);
  // Everything lives inside the composer card: auto-scroll opens its bottom
  // row, then the instruments (autonomy, model, access); the todos sit beside
  // its menus, and the session details open from its "…" menu.
  // Without a prompt bar the original strip above stands in.
  const instruments = props.hasMeta ? (
    <AgentSessionMeta {...props} metaVariant="session" section="instruments" />
  ) : null;
  const promptBar = props.shouldShowPromptBar ? (
    <AgentSessionPrompt
      {...props}
      instruments={instruments}
      sessionInfo={sessionInfo}
      onScheduleRequest={schedules.requestSchedule}
      schedules={schedules.section}
    />
  ) : null;
  const utilities =
    props.hasMeta && !promptBar ? (
      <AgentSessionMeta {...props} metaVariant="session" section="utilities" />
    ) : null;

  return (
    <div className={props.collapsible ? COLLAPSIBLE_ROOT_CLASS : FULL_PAGE_ROOT_CLASS}>
      {props.shouldShowPromptBar && schedules.dialog}
      {utilities}
      {promptBar ?? instruments}
      {!promptBar && (
        <ComposerContextUsage contextUsage={contextUsage} isAgentWorking={props.isAgentWorking} />
      )}
    </div>
  );
});

/** Why the active mode won't hold with this model, or null when it will. */
function modeIncompatibleReason(session: AgentSessionProps): string | null {
  if (session.modelSupportsAutoMode !== false || !session.permissionMode) return null;
  const mode = findProviderMode(
    session.selection?.providerId,
    session.permissionMode,
    session.providerModes,
  );
  if (mode?.risk !== "auto") return null;
  return `This model can't run ${mode.label}, so the session falls back to accepting edits only. Pick a model that supports it, or another mode.`;
}

function AgentSessionMeta(
  props: AgentSessionComposerProps & {
    metaVariant: "session" | "standalone";
    section: MetaBarSection;
  },
): ReactElement {
  const session = props.sessionProps;
  return (
    <MetaBar
      ref={props.section === "utilities" ? undefined : props.metaBarRef}
      section={props.section}
      onPermissionModeSet={session.onPermissionModeSet}
      modeIncompatibleReason={modeIncompatibleReason(session)}
      variant={props.metaVariant}
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
      activeClaudeProfile={props.activeClaudeProfile}
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
    instruments: ReactElement | null;
    sessionInfo: ReturnType<typeof useComposerSessionInfo>;
    onScheduleRequest?: (prompt: string, onSaved: () => void) => void;
    schedules: ReactElement | null;
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
  const sideConversations = useMemo(
    () =>
      session.sessionId != null && props.projectPath ? (
        <SideConversations sourceSessionId={session.sessionId} cwd={props.projectPath} />
      ) : undefined,
    [props.projectPath, session.sessionId],
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
      pendingQuestionRequestId={session.pendingQuestionRequestId}
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
      isFirstPrompt={session.blocks.length === 0}
      contextUsage={session.contextUsage}
      sessionInfo={props.sessionInfo}
      instrumentStart={composerAutoScroll(props)}
      instrumentTrailing={composerUtilities(props)}
      steeringAcknowledged={session.steeringAcknowledged}
      launchManifest={launchManifest(props)}
      sideConversations={sideConversations}
      schedules={props.schedules}
      instrumentLeading={props.instruments}
      slashCommandsOverride={session.slashCommandsOverride}
      slashCommandsLoading={session.slashCommandsLoading}
      slashCommandsError={session.slashCommandsError}
      promptCommandPolicy={session.promptCommandPolicy}
      pendingPermission={session.pendingPermission}
      referencedWorktreeSelection={referencedWorktreeSelection}
      onPermissionDecision={session.onPermissionDecision}
      isSubmittingPermission={session.isSubmittingPermission}
    />
  );
}

/** Where the first prompt will run (branch/worktree), atop the composer card. */
function launchManifest(props: AgentSessionComposerProps): ReactElement | undefined {
  const session = props.sessionProps;
  if (!props.showWorktreeChip) return undefined;
  return (
    <LaunchManifest
      worktreeProjectId={session.worktreeProjectId}
      worktreeDefaultBranch={session.worktreeDefaultBranch}
      worktreeProjectPath={session.worktreeProjectPath}
      worktreeMode={session.worktreeMode}
      onWorktreeModeChange={session.onWorktreeModeChange}
      worktreeSelectedBranch={session.worktreeSelectedBranch}
      onWorktreeBranchChange={session.onWorktreeBranchChange}
    />
  );
}

/** Follow-output, opening the composer's instrument row. */
function composerAutoScroll(props: AgentSessionComposerProps): ReactElement | undefined {
  if (!props.hasMeta || !props.showAutoScrollChip) return undefined;
  return (
    <AutoScrollChip
      variant="instrument"
      enabled={props.autoScrollEnabled}
      onToggle={props.onToggleAutoScroll}
    />
  );
}

/** The agent's todos, beside the composer's menus. */
function composerUtilities(props: AgentSessionComposerProps): ReactElement | undefined {
  const todos = props.sessionProps.todos;
  if (!props.hasMeta || !todos || todos.length === 0) return undefined;
  return <AgentTodoList todos={todos} variant="instrument" />;
}

function ComposerContextUsage({
  contextUsage,
  isAgentWorking,
}: {
  contextUsage: AgentSessionProps["contextUsage"];
  isAgentWorking: boolean;
}) {
  if (!contextUsageToShow(contextUsage, isAgentWorking)) return null;

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
