import type { ReactNode } from "react";
import type { SlashCommand } from "@/lib/slash-command";
import type { SessionInfoPanelProps } from "./agent-session/SessionInfoChip";
import type { PromptCommandPolicy } from "@/lib/prompt-command-policy";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { ContextUsageState, LiveAgentStatus } from "@/types/agent";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type { PermissionMode } from "@/types/permission-mode";
import type { AgentQuestion, AgentQuestionAnswers } from "@/types/agent-question";
import type { PendingPermission, PermissionDecisionValue } from "@/types/agent-permission";

export interface ReferencedWorktreeSelection {
  mode: WorktreeMode;
  selectedBranch: string | null;
  onSelect: (branch: string) => void;
}

export interface SplitSendAction {
  label: string;
  icon: ReactNode;
  onClick: (text: string, attachments?: PromptAttachmentPayload[]) => void | Promise<void>;
  variant?: "default" | "outline";
  kbdShortcut?: string[];
}

export interface AgentPromptBarProps {
  /**
   * Called when the user submits the prompt. May return a Promise — the
   * prompt bar awaits it before clearing the input so a failed save
   * (e.g. worktree settings persistence) doesn't drop the user's text.
   * Errors are surfaced via toast inside the consumer; the bar restores
   * the draft on rejection.
   */
  onSend: (message: string, attachments?: PromptAttachmentPayload[]) => void | Promise<void>;
  /**
   * Schedule the typed message for future delivery. When provided (and a DB
   * `sessionId` exists), a "schedule" affordance appears next to Send. Rejects
   * on failure so the bar keeps the user's text.
   */
  /** Opens the conversation's schedule editor prefilled with `prompt`.
   *  `onSaved` runs once the schedule is persisted, clearing the composer. */
  onScheduleRequest?: (prompt: string, onSaved: () => void) => void;
  onStop: () => void;
  status: LiveAgentStatus;
  splitSendActions?: SplitSendAction[];
  disabled?: boolean;
  pendingQuestions?: AgentQuestion[];
  pendingQuestionRequestId?: string;
  onQuestionResponse?: (response: AgentQuestionAnswers) => void;
  disableShortcuts?: boolean;
  onCollapse?: () => void;
  permissionMode?: PermissionMode;
  onPermissionModeToggle?: () => void;
  pendingPlanApproval?: { allowedPrompts?: Array<{ tool: string; prompt: string }> } | null;
  planApproveLabel?: string;
  planApprovalError?: string | null;
  onPlanApprove?: () => void;
  onPlanRequestChanges?: (feedback: string) => void;
  onPlanReject?: () => void;
  onGateClose?: () => void;
  onOpenModelPicker?: () => void;
  agentTabActive?: boolean;
  featureId?: number;
  projectId?: number;
  sessionId?: number;
  wsSessionId?: string;
  /** Active provider controls which prompt attachment types are accepted. */
  providerId?: string;
  onToggleMaximize?: () => void;
  noTopPadding?: boolean;
  /** No turn has been sent yet in this conversation. */
  isFirstPrompt?: boolean;
  /**
   * The provider delivers a mid-turn prompt into the running turn. When false,
   * Enter while the agent works queues instead of steering. Default true.
   */
  steeringAcknowledged?: boolean;
  /** Session details (provider, MCP servers, ids, resume) for the composer's menu. */
  sessionInfo?: SessionInfoPanelProps;
  /**
   * Session utilities (the todo list) rendered just before the composer's
   * own menus in the instrument row.
   */
  instrumentTrailing?: ReactNode;
  /** Opens the instrument row (auto-scroll), set off by a hairline. */
  instrumentStart?: ReactNode;
  /** Context-window usage for the instrument row's meter. */
  contextUsage?: ContextUsageState | null;
  /** First-prompt launch line (where the agent will work), shown atop the card. */
  launchManifest?: ReactNode;
  /** Side questions asked from this conversation, stacked on top of the card. */
  sideConversations?: ReactNode;
  /**
   * Session controls (mode, model/effort…) rendered at the start of the
   * composer card's instrument row, supplied by the session embedder.
   */
  instrumentLeading?: ReactNode;
  slashCommandsOverride?: SlashCommand[];
  promptCommandPolicy?: PromptCommandPolicy;
  slashCommandsLoading?: boolean;
  pendingPermission?: PendingPermission | null;
  /**
   * Pre-first-prompt selection state used to offer the live worktree of a
   * referenced conversation. Omitted once the conversation has started.
   */
  referencedWorktreeSelection?: ReferencedWorktreeSelection;
  onPermissionDecision?: (
    decision: PermissionDecisionValue,
    feedback?: string,
    optionId?: string,
  ) => void;
  /**
   * True while a permission decision is in flight to the backend. Disables
   * the option buttons / shortcuts and shows a spinner so the user does not
   * double-submit.
   */
  isSubmittingPermission?: boolean;
}

export interface AgentPromptBarHandle {
  focusInput: () => void;
  /**
   * Imperatively replace the composer text (e.g. a rewound/forked message
   * restored as an editable draft) and persist it, without sending.
   */
  setDraft: (text: string) => void;
}
