import type { Loader2Icon } from "lucide-react";
import type { AgentBlockData } from "../AgentBlock";
import type { AgentType } from "../../types/agent-types";
import type { PromptAttachmentPayload } from "../../types/agent-types";
import type { AgentQuestion, AgentQuestionAnswers } from "../AgentQuestionDrawer";
import type { TodoItem } from "@/types/agent";
import type { ContextUsageState } from "@/types/agent";
import type { PendingPermission } from "../ToolPermissionPrompt";
// `AgentSession` is a live UI consumer — it reads the canonical 3-value
// status pushed by the backend. Workflow-level lifecycle decisions live
// elsewhere (and use the legacy `AgentStatus`).
import type { LiveAgentStatus as AgentStatus } from "@/types/agent";
import type { SlashCommand } from "@/hooks/useSlashCommand";
import type { ThinkingEffortLevel } from "@/shared/thinking-effort";
import type { PermissionMode } from "@/types/permission-mode";
import type { CodexPermissionMode } from "@/types/codex-permission-mode";
import type { WorktreeMode } from "@/lib/worktree-mode";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { AgentCatalog } from "@/api/agentRuntime";
import type { ClaudeProfileSelection } from "./useClaudeProfileSelection";
import type { TurnLifecycle } from "@/stores/ws-turn-lifecycle";
import type { TurnTimingState } from "@/stores/ws-turn-timing";

export interface AgentSessionProps {
  /** The type of agent being displayed */
  agentType: AgentType;
  /** The blocks (stream output) to render */
  blocks: AgentBlockData[];
  /**
   * Pre-filtered subset of `blocks` excluding subagent children. When the
   * caller already maintains this incrementally (e.g. the WS session store),
   * forward it so AgentStream skips the per-render filter scan. Optional —
   * AgentStream falls back to filtering `blocks` itself when omitted.
   */
  rootBlocks?: AgentBlockData[];
  /**
   * Map from a tool_call's `toolUseId` to its `tool_result` block. Same
   * incremental-vs-fallback contract as `rootBlocks`.
   */
  toolResultMap?: Map<string, AgentBlockData>;
  /** Rendered Virtuoso row count prepended by older-history pagination. */
  historyPrependDisplayOffset?: number;
  /** Current status of the agent */
  status: AgentStatus;
  /** True while backend-confirmed context compaction is running. */
  isCompacting?: boolean;
  /** Provider-neutral lifecycle for active/paused/terminal turn state. */
  lifecycle?: TurnLifecycle;
  /** Provider-neutral timing accumulator for the current or latest turn. */
  turnTiming?: TurnTimingState;
  /**
   * Called when the user sends a message via the prompt bar. May return a
   * Promise — the prompt bar awaits it before clearing the input so a
   * failed pre-send step (e.g. saving worktree settings) doesn't drop the
   * user's text. Consumers should toast errors themselves.
   */
  onSend: (
    message: string,
    attachments?: PromptAttachmentPayload[],
    claudeProfile?: string,
  ) => void | Promise<void>;
  /** Called when the user clicks the stop button */
  onStop: () => void;
  /** Active questions from AskUserQuestion tool calls */
  pendingQuestions?: AgentQuestion[];
  /** Called when the user submits a response to questions */
  onAnswerSubmit?: (response: AgentQuestionAnswers) => void;
  /** When true, disables keyboard shortcuts in the question drawer */
  disableShortcuts?: boolean;
  /** Override label (e.g. for a named sub-agent) */
  label?: string;
  /** Override icon (lucide component) */
  icon?: typeof Loader2Icon;
  /** When true, wrap content in a collapsible panel. When false, render full-screen. */
  collapsible?: boolean;
  /** Additional class names */
  className?: string;
  /** Whether to show a "resumable" indicator */
  resumable?: boolean;
  /** Called when user clicks resume */
  onResume?: () => void;
  /** Whether the prompt bar send button should be disabled */
  disabled?: boolean;
  /** Controlled open state (collapsible mode only) */
  open?: boolean;
  /** Toggle callback (collapsible mode only) */
  onToggle?: () => void;
  /** Index for DOM-based keyboard navigation (sets data-nav-agent-index) */
  navAgentIndex?: number;
  /** Whether this agent can be deleted */
  canDelete?: boolean;
  /** Called when user clicks delete */
  onDelete?: () => void;
  /** Todo list from TodoWrite tool calls */
  todos?: TodoItem[] | null;
  /** Current permission mode (session agents only) */
  permissionMode?: PermissionMode;
  /** Called when user toggles permission mode */
  onPermissionModeToggle?: () => void;
  /**
   * Per-provider opt-in modes the user has unlocked via provider settings.
   * Driven by provider-level opt-in workspace settings.
   */
  enabledOptInModes?: PermissionMode[];
  providerModes?: readonly RuntimeProviderModeOption[];
  codexPermissionMode?: CodexPermissionMode;
  codexPermissionDefaultMode?: CodexPermissionMode;
  isCodexPermissionModePending?: boolean;
  onCodexPermissionModeChange?: (mode: CodexPermissionMode) => void;
  /** Optional catalog query supplied by parents that already fetched it. */
  agentCatalog?: { data?: AgentCatalog };
  /** Pending plan approval from ExitPlanMode tool call */
  pendingPlanApproval?: {
    allowedPrompts?: Array<{ tool: string; prompt: string }>;
  } | null;
  /** Label for the approve button */
  planApproveLabel?: string;
  /** Error from a failed plan approval attempt */
  planApprovalError?: string | null;
  /** Called when user approves the plan */
  onPlanApprove?: () => void;
  /** Called when user requests changes to the plan */
  onPlanRequestChanges?: (feedback: string) => void;
  /** Called when user rejects the plan and stops the agent */
  onPlanReject?: () => void;
  /** Called when the active permission/question/plan gate is closed without approval */
  onGateClose?: () => void;
  /** Context usage data for this session */
  contextUsage?: ContextUsageState | null;
  /** Current model ID for the session (used for inline model switcher) */
  currentModelId?: string;
  /** Current runtime provider ID for the session */
  currentProviderId?: string;
  /** Called when the user changes the provider before the first message */
  onProviderChange?: (providerId: string) => void;
  /**
   * Called when the user changes the model via the inline switcher. Receives
   * both the picked provider and model id so handlers don't have to read
   * (potentially stale) provider state from the WS store.
   */
  onModelChange?: (providerId: string, modelId: string) => void;
  /** Current thinking effort override for this live session (unvalidated from the store). */
  currentThinkingEffort?: string;
  /** Show a non-interactive model chip even when model changes are disabled. */
  showReadOnlyModel?: boolean;
  /** Called when the user changes live thinking effort */
  onThinkingEffortChange?: (thinkingEffort?: ThinkingEffortLevel) => void;
  /** Feature ID for file mention and slash command support in the prompt bar */
  featureId?: number;
  /** Project ID for slash command support and prompt history in the prompt bar */
  projectId?: number;
  /** Agent session DB ID for draft persistence */
  sessionId?: number;
  /** WS store key for WS-based history and draft persistence */
  wsSessionId?: string;
  /** Initial draft text (restored from DB) */
  /** Active subprocess ID for slash command support in the prompt bar */
  subprocessId?: string;
  /** Pending tool permission request from canUseTool callback */
  pendingPermission?: PendingPermission | null;
  /** Called when user makes a permission decision */
  onPermissionDecision?: (
    decision: "allow_once" | "allow_future" | "deny",
    feedback?: string,
    optionId?: string,
  ) => void;
  /**
   * True while a permission decision is in flight to the backend (between
   * click and ack). Disables option buttons and shows a loader so the user
   * does not double-submit.
   */
  isSubmittingPermission?: boolean;
  /** Called when user clicks "Mark Done" */
  onMarkDone?: () => void;
  /** Whether this agent is maximized (takes full height, hides others) */
  maximized?: boolean;
  /** Called when user clicks maximize/minimize */
  onToggleMaximize?: () => void;
  /** Optional externally-owned Claude profile selector state. */
  claudeProfileSelection?: ClaudeProfileSelection;
  /** Runtime provider ID backing this session */
  runtimeProvider?: string;
  /** Opaque runtime session ID to display above the prompt bar */
  runtimeSessionId?: string;
  /** Override slash commands (bypasses tRPC fetch). Used by ws-session. */
  slashCommandsOverride?: SlashCommand[];
  /** Whether the override commands are still loading */
  slashCommandsLoading?: boolean;
  /** Whether older messages exist beyond current window */
  hasMore?: boolean;
  /**
   * Called when user scrolls to top and older messages should be loaded.
   * Resolves with the number of blocks that were prepended (or `void` for
   * legacy callers that haven't migrated). WS sessions preserve prepend
   * anchoring through `historyPrependDisplayOffset`.
   */
  onLoadOlder?: () => Promise<number | void>;
  /**
   * Pre-first-prompt branch/worktree picker — a two-chip group: a Branch chip
   * (chevron + virtualized branch list, default = the project's current
   * branch) and an explicit behavior menu (`WorktreeMode`). The chip renders
   * only when the embedder supplies the project id, mode, and both setters.
   */
  worktreeProjectId?: number;
  worktreeDefaultBranch?: string;
  worktreeProjectPath?: string;
  worktreeMode?: WorktreeMode;
  onWorktreeModeChange?: (mode: WorktreeMode) => void;
  worktreeSelectedBranch?: string | null;
  onWorktreeBranchChange?: (next: string | null) => void;
  /**
   * Whether the agent tab is the visible tab for this feature. Forwarded
   * to `AgentPromptBar` so its agent-menu shortcuts (⌘P open model picker,
   * ⌘↵, ⇧Tab, ⌘⇧Z) only fire when the agent tab is active. Default: true.
   */
  agentTabActive?: boolean;
}

/** Handle exposed by AgentSession via forwardRef */
export interface AgentSessionHandle {
  /** Focus the prompt bar textarea */
  focusPromptBar: () => void;
  /**
   * Focus the most relevant interactive element in priority order:
   * 1. Permission prompt first button (if pending)
   * 2. Prompt bar / question drawer
   * 3. Header (fallback)
   */
  focusActiveInput: () => void;
  /** Whether the collapsible panel is currently open */
  isOpen: boolean;
}
