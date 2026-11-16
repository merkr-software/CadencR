import type { ReactElement, ReactNode } from "react";
import { AgentPromptPendingIndicator } from "./AgentPromptPendingIndicator";
import type { AgentPromptBarProps } from "./agent-prompt-bar-types";
import { ReferencedWorktreeTip } from "./ReferencedWorktreeTip";
import { ComposerHelp } from "./composer/ComposerHelp";
import { ComposerStack } from "./composer/ComposerStack";
import { QueueRail } from "./composer/QueueRail";
import { RunningAgents } from "./composer/RunningAgents";
import { VirtualSkillWizard } from "./composer/VirtualSkillWizard";
import type { AgentPromptBarController } from "./useAgentPromptBarController";

/**
 * The composer card's stack, top to bottom: what runs in this conversation
 * (agents, side questions), what will reach it later (schedules, the queue),
 * what waits on the user, then what the draft itself calls up (worktree tip,
 * help, skill wizard) — closest to the prompt it belongs to.
 */
export function AgentPromptStack({
  props,
  controller,
}: {
  props: AgentPromptBarProps;
  controller: AgentPromptBarController;
}): ReactElement {
  const { state, special } = controller;
  return (
    <ComposerStack>
      {/* Above a gate, `AgentGateStack` shows these two: one live copy each. */}
      {!special.hasSpecialState && <RunningAgents />}
      {props.sideConversations}
      {!special.hasSpecialState && props.schedules}
      <QueueRail />
      {special.permissionDeferred && props.pendingPermission && (
        <AgentPromptPendingIndicator kind="permission" detail={props.pendingPermission.toolName} />
      )}
      {special.planApprovalDeferred && <AgentPromptPendingIndicator kind="plan" />}
      {special.questionsDeferred && <AgentPromptPendingIndicator kind="question" />}
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
        <div data-stack-tone="neutral" className="shrink-0 bg-popover">
          <ComposerHelp />
        </div>
      )}
      <VirtualSkillWizard
        state={controller.sending.skillWizard}
        editorRef={state.editorRef}
        shortcutsEnabled={(props.agentTabActive ?? true) && !props.disableShortcuts}
      />
    </ComposerStack>
  );
}

/**
 * The stack while a permission, plan or question stands in for the composer:
 * only what stays true around it — the agents at work (often the one asking)
 * and what is scheduled. The rest belongs to the draft, hidden meanwhile.
 */
export function AgentGateStack({ schedules }: { schedules: ReactNode }): ReactElement {
  return (
    <ComposerStack>
      <RunningAgents />
      {schedules}
    </ComposerStack>
  );
}
