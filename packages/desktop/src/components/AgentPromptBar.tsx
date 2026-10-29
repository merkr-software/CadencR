import { forwardRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";
import { formatKey } from "@/lib/shortcuts/format";
import { withSideQuestionSkill } from "@/lib/side-question-skill";
import { AgentPromptPendingIndicator } from "./AgentPromptPendingIndicator";
import type { AgentPromptBarHandle, AgentPromptBarProps } from "./agent-prompt-bar-types";
import { AgentQuestionDrawer } from "./AgentQuestionDrawer";
import { PlanApprovalBar } from "./PlanApprovalBar";
import { PromptBarActions } from "./PromptBarActions";
import { PromptEditor } from "./prompt-editor/PromptEditor";
import { ReferencedWorktreeTip } from "./ReferencedWorktreeTip";
import { ShellCommandModeMarker } from "./ShellCommandModeMarker";
import { SplitSendActions } from "./SplitSendActions";
import { ToolPermissionPrompt } from "./ToolPermissionPrompt";
import { AssistMenu } from "./composer/AssistMenu";
import { CompactionHint } from "./composer/CompactionHint";
import { ComposerHelp } from "./composer/ComposerHelp";
import { ComposerContextProvider, ComposerDraftProvider } from "./composer/ComposerContext";
import { ContextMeter } from "./composer/ContextMeter";
import { ContextTray } from "./composer/ContextTray";
import { HistoryButton } from "./composer/HistoryButton";
import { QueueRail } from "./composer/QueueRail";
import { RunningSweep } from "./composer/RunningSweep";
import { StopArmHint } from "./composer/StopArmHint";
import { useComposerContextValue } from "./composer/useComposerContextValue";
import { VirtualSkillWizard } from "./composer/VirtualSkillWizard";
import { InstrumentPlacementContext } from "./composer/InstrumentPlacement";
import { InstrumentRow } from "./composer/InstrumentRow";
import { useInstrumentRows, type PlaceInstrument } from "./composer/useInstrumentRows";
import {
  useAgentPromptBarController,
  type AgentPromptBarController,
} from "./useAgentPromptBarController";

export type { AgentPromptBarHandle, SplitSendAction } from "./agent-prompt-bar-types";

export const AgentPromptBar = forwardRef<AgentPromptBarHandle, AgentPromptBarProps>(
  function AgentPromptBar(props, ref) {
    const controller = useAgentPromptBarController(props, ref);
    return (
      <>
        <DeferredPromptIndicators props={props} controller={controller} />
        <SpecialPrompt props={props} controller={controller} />
        <PromptComposer props={props} controller={controller} />
      </>
    );
  },
);

function DeferredPromptIndicators({
  props,
  controller,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
}) {
  return (
    <>
      {controller.special.permissionDeferred && props.pendingPermission && (
        <AgentPromptPendingIndicator kind="permission" detail={props.pendingPermission.toolName} />
      )}
      {controller.special.planApprovalDeferred && <AgentPromptPendingIndicator kind="plan" />}
      {controller.special.questionsDeferred && <AgentPromptPendingIndicator kind="question" />}
    </>
  );
}

function SpecialPrompt({
  props,
  controller,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
}) {
  const special = controller.special;
  const content =
    special.visiblePermission && props.onPermissionDecision ? (
      <ToolPermissionPrompt
        key={
          special.visiblePermission.requestId ??
          `${special.visiblePermission.toolName}:${special.visiblePermission.pattern}`
        }
        permission={special.visiblePermission}
        onDecision={props.onPermissionDecision}
        onCancel={props.onGateClose}
        disableShortcuts={props.disableShortcuts}
        isSubmitting={!!props.isSubmittingPermission}
      />
    ) : special.visiblePlanApproval && props.onPlanApprove && props.onPlanRequestChanges ? (
      <PlanApprovalBar
        allowedPrompts={special.visiblePlanApproval.allowedPrompts}
        initialFeedback={controller.state.text}
        approveLabel={props.planApproveLabel}
        onApprove={props.onPlanApprove}
        onRequestChanges={props.onPlanRequestChanges}
        onReject={props.onGateClose ?? props.onPlanReject}
        error={props.planApprovalError}
      />
    ) : special.visibleQuestions?.length && props.onQuestionResponse ? (
      <AgentQuestionDrawer
        questions={special.visibleQuestions}
        open
        onSubmit={props.onQuestionResponse}
        onCancel={props.onGateClose}
        inline
        disableShortcuts={props.disableShortcuts}
      />
    ) : null;
  return content ? (
    <div data-permission-area={!!special.visiblePermission} data-question-area>
      {content}
    </div>
  ) : null;
}

function PromptComposer({
  props,
  controller,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
}) {
  const { state } = controller;
  const composerContext = useComposerContextValue(props, controller);
  return (
    <ComposerContextProvider value={composerContext}>
      <ComposerDraftProvider value={state.text}>
        <div
          ref={state.wrapperRef}
          data-agent-prompt-bar="true"
          hidden={controller.special.hasSpecialState}
          aria-hidden={controller.special.hasSpecialState}
          className={cn(
            "flex min-h-0 flex-col px-3 pb-4",
            props.noTopPadding ? "pt-0" : "pt-3",
            "group-data-[agent-dragover]/agent-section:ring-2 group-data-[agent-dragover]/agent-section:ring-inset group-data-[agent-dragover]/agent-section:ring-primary/50",
          )}
          {...state.attachments.dragHandlers}
        >
          {props.sideConversations}
          <QueueRail />
          {props.referencedWorktreeSelection && props.projectId != null ? (
            <ReferencedWorktreeTip
              prompt={state.text}
              projectId={props.projectId}
              selection={props.referencedWorktreeSelection}
              agentTabActive={props.agentTabActive ?? true}
              shortcutsDisabled={props.disableShortcuts ?? false}
            />
          ) : null}
          {state.text === "?" && (
            // A lone "?" asks how the composer works: answer in place.
            <div className="mx-2 rounded-t-lg border border-b-0 border-border/70 bg-popover">
              <ComposerHelp />
            </div>
          )}
          <VirtualSkillWizard
            state={controller.sending.skillWizard}
            editorRef={state.editorRef}
            shortcutsEnabled={(props.agentTabActive ?? true) && !props.disableShortcuts}
          />
          <PromptSurface props={props} controller={controller} />
          {props.splitSendActions && !controller.isRunning && !controller.isShellCommandMode && (
            <SplitSendActions
              actions={props.splitSendActions}
              disabled={!controller.sending.canSend}
              onAction={controller.sending.handleSplitAction}
            />
          )}
        </div>
      </ComposerDraftProvider>
    </ComposerContextProvider>
  );
}

/**
 * The composer card: launch manifest (first prompt), session header (only
 * when one instrument row runs out of room), context tray, the editor, then
 * the instrument row (`useInstrumentRows`).
 */
function PromptSurface({
  props,
  controller,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
}) {
  const queueCombo = useShortcutLabel("agent-send");
  const { editorActions, sending, state } = controller;
  const rows = useInstrumentRows();
  const slashCommands = useMemo(
    () => withSideQuestionSkill(props.slashCommandsOverride, props.sessionId),
    [props.slashCommandsOverride, props.sessionId],
  );
  return (
    <div
      data-composer-card
      data-shell-command-mode={controller.isShellCommandMode || undefined}
      data-running={controller.isRunning || undefined}
      className="glass-surface flex max-h-[calc(var(--app-vh,100dvh)*0.4)] min-h-0 flex-col rounded-lg border border-transparent bg-muted/40 transition-colors focus-within:bg-muted/55"
      onClick={editorActions.handleSurfaceClick}
    >
      {controller.isRunning && <RunningSweep />}
      {props.isFirstPrompt && props.launchManifest}
      <InstrumentRow
        top
        hidden={!rows.split}
        start={rows.zones.topLeft}
        end={rows.zones.topRight}
      />
      <ContextTray />
      <div
        className={cn(
          "flex min-h-0 flex-1 items-start gap-1.5 px-4 pb-2",
          rows.split ? "pt-2" : "pt-3.5",
        )}
      >
        {controller.isShellCommandMode && (
          <ShellCommandModeMarker onClear={editorActions.clearShellCommandMode} />
        )}
        <PromptEditor
          ref={state.editorRef}
          onChange={editorActions.handleEditorChange}
          onEnterSend={sending.handleEnterSend}
          onModEnterSend={sending.handleModEnterSend}
          onArrowUp={editorActions.handleArrowUp}
          onArrowDown={editorActions.handleArrowDown}
          isBrowsingHistory={editorActions.isBrowsingHistory}
          disabled={props.disabled || sending.sending}
          placeholder={promptPlaceholder(props, controller, queueCombo)}
          className="min-h-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-sm leading-[22px] shadow-none focus:border-0 focus:ring-0"
          mentionProjectId={props.projectId}
          mentionFeatureId={props.featureId}
          slashCommands={slashCommands}
          slashCommandsLoading={props.slashCommandsLoading}
          promptCommandPolicy={controller.promptCommandPolicy}
          onPasteImages={state.attachments.addFiles}
          onPasteLongText={editorActions.handlePasteLongText}
        />
      </div>
      <InstrumentRow
        rowRef={rows.rowRef}
        start={rows.zones.bottomLeft}
        end={rows.zones.bottomRight}
      />
      <ComposerInstruments props={props} controller={controller} place={rows.place} />
    </div>
  );
}

/**
 * Every instrument of the card, each claiming its slot in the instrument rows.
 * The session embedder's controls (`instrumentLeading`) claim theirs through
 * `InstrumentPlacementContext`.
 */
function ComposerInstruments({
  props,
  controller,
  place,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
  place: PlaceInstrument;
}) {
  const { sending, state } = controller;
  return (
    <>
      {place("autoscroll", props.instrumentStart)}
      <InstrumentPlacementContext.Provider value={place}>
        {props.instrumentLeading}
      </InstrumentPlacementContext.Provider>
      {place("compaction", <CompactionHint />)}
      {place("meter", <ContextMeter />)}
      {place("todos", props.instrumentTrailing)}
      {place("history", <HistoryButton />)}
      {place("assist", <AssistMenu />)}
      {place("stop-arm", <StopArmHint />)}
      {place(
        "actions",
        <PromptBarActions
          onAddFiles={state.attachments.addFiles}
          providerId={props.providerId}
          inputsDisabled={!!props.disabled || sending.sending || controller.isShellCommandMode}
          isRunning={controller.isRunning}
          onStop={props.onStop}
          onSend={sending.handleSend}
          canSend={sending.canSend}
          sending={sending.sending}
          showSendButton={controller.isShellCommandMode || !props.splitSendActions}
          schedule={controller.isShellCommandMode ? undefined : sending.scheduleControl}
          onQueue={sending.canQueue ? sending.handleQueue : undefined}
          queuesOnEnter={sending.queuesOnEnter}
        />,
      )}
    </>
  );
}

/** The placeholder states what Enter will do right now (phones have no keys to cite). */
function promptPlaceholder(
  props: AgentPromptBarProps,
  controller: AgentPromptBarController,
  queueCombo: string,
) {
  if (controller.sending.sending) return "Sending…";
  if (controller.state.isMobile) {
    if (props.status === "question") return "Answer to resume…";
    if (controller.isRunning)
      return controller.sending.queuesOnEnter ? "Queue a message…" : "Steer the agent…";
    return props.isFirstPrompt ? "Describe the task…" : "Message the agent…";
  }
  if (props.status === "question") return "Answer to resume the agent…";
  // Plain Enter is wired in the prompt editor, not the registry: format the
  // token so Linux reads "Enter" where macOS draws the return glyph.
  const enter = formatKey("enter");
  if (controller.sending.queuesOnEnter)
    return `${enter} to queue your message until the agent finishes`;
  if (controller.isRunning)
    return `${enter} to steer the agent at its next step, ${queueCombo} to queue it after this turn`;
  if (props.isFirstPrompt) return "Describe the task — @ for files, / for commands";
  return `Message the agent — @ files, @@ conversations, ${controller.promptCommandHint}`;
}
