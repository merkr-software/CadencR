/**
 * Types and helpers for WebSocket session state.
 */

import type { AgentBlockData } from "@/components/AgentBlock";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";
import type { TodoItem } from "@/types/agent";
import type { ContextUsageState } from "@/types/agent";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";
import type { AgentQuestion, AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import type { SlashCommand } from "@/hooks/useSlashCommand";
import type { WorktreeStatus } from "@/types/workflow";
import type { WsConnection } from "@/lib/ws-connection";
import type {
  FirstPromptBranchSetup,
  GateCloseReason,
  WsEnvelope,
  SessionConfig,
  PromptDispatchOptions,
} from "@/lib/ws-envelope";
import type { PermissionDecisionValue } from "@/components/ToolPermissionPrompt";
import type { StreamingState } from "./ws-message-processing";
import { createStreamingState } from "./ws-message-processing";
import type { TurnLifecycle } from "./ws-turn-lifecycle";
import { createIdleTurnLifecycle } from "./ws-turn-lifecycle";
import {
  createTurnTiming,
  formatTurnDuration,
  transitionTurnTiming,
  type TurnTimingState,
} from "./ws-turn-timing";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import { DEFAULT_PROVIDER, FALLBACK_MODEL_ID } from "../shared/models";
import { defaultEditModeFor } from "../lib/provider-modes";
import type { PermissionMode } from "../types/permission-mode";
import type { CodexPermissionMode } from "@/types/codex-permission-mode";
import type { PromptAttachmentPayload } from "@/types/agent-types";

export type { PermissionMode };

export interface PendingPlanApproval {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  plan?: string;
}

/** Snapshot fed into `setPersistedState` to hydrate the WS store from REST. */
export interface PersistedStatePayload {
  blocks: AgentBlockData[];
  lifecycle: TurnLifecycle;
  hasMore?: boolean;
  oldestMessageId?: number | null;
  /** Highest DB message id in this snapshot — seeds the resync cursor. */
  maxMessageId?: number | null;
  featureId?: number;
  sessionDbId?: number;
  currentProviderId?: string;
  currentModelId?: string;
  currentThinkingEffort?: string;
  currentProfile?: string;
  permissionMode?: PermissionMode;
  codexPermissionMode?: CodexPermissionMode;
  runtimeProvider?: string | null;
  runtimeSessionId?: string | null;
  pendingPlanApproval?: PendingPlanApproval | null;
  /** Raw `agent_sessions.pending_permission` JSON, or null. */
  pendingPermission?: unknown;
  /** Raw `agent_sessions.pending_questions` JSON, or null. */
  pendingQuestions?: unknown;
  contextUsage?: ContextUsageState | null;
  hasFileChanges?: boolean;
}

export interface QueuedPrompt {
  text: string;
  attachments?: PromptAttachmentPayload[];
  branchSetup?: FirstPromptBranchSetup;
  claudeProfile?: string;
  /** Correlation ref carried to the flushed `prompt.send` (see PromptDispatchOptions). */
  userMessageRef?: string;
}

export interface McpServerStatus {
  name: string;
  status: string;
}

/** Provider-neutral transport health for the agent stream. */
export interface StreamHealth {
  state: "ok" | "degraded";
  /** Free-form human-readable reason; suitable for a tooltip. */
  reason?: string;
  /** `Date.now()` when the current state was entered. */
  since?: number;
}

/**
 * Explicit anchor for a message resync, supplied by the "Sync from CLI" action.
 * Bypasses the store's own (possibly stale) `sessionDbId`/cursor so only the
 * rows the backend just appended (`id > cursor`) are fetched and merged.
 */
export interface ResyncTarget {
  featureId: number;
  sessionDbId: number;
  cursor: number;
}

export function createStreamHealth(): StreamHealth {
  return { state: "ok" };
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

export interface SessionEntry {
  conn: WsConnection | null;
  isConnected: boolean;
  serverSessionId: string;
  lifecycle: TurnLifecycle;
  turnTiming: TurnTimingState;
  streamingState: StreamingState;
  blocks: AgentBlockData[];
  /**
   * Pre-filtered subset of `blocks` excluding subagent children. Maintained
   * incrementally inside `applyMutations` so that AgentStream consumers do
   * not re-derive it from `blocks` on every streamed chunk.
   */
  rootBlocks: AgentBlockData[];
  /**
   * Map from a tool_call's `toolUseId` to its `tool_result` block. Maintained
   * incrementally so AgentBlock can inline tool results without scanning the
   * whole conversation per render.
   */
  toolResultMap: Map<string, AgentBlockData>;
  /** Rendered Virtuoso row count prepended by older-history pagination. */
  historyPrependDisplayOffset: number;
  pendingPermission: PendingPermission | null;
  pendingPermissionQueue: PendingPermission[];
  pendingRequestId: string;
  /**
   * `request_id` of a permission decision that has been clicked locally and is
   * currently in flight to the backend. Null when no submission is pending.
   * Used to disable buttons and show a spinner in `ToolPermissionPrompt` so
   * the user doesn't double-submit while waiting for the ack.
   */
  submittingPermissionRequestId: string | null;
  pendingQuestions: AgentQuestion[];
  pendingQuestionToolInput: Record<string, unknown>;
  permissionMode: PermissionMode;
  codexPermissionMode: CodexPermissionMode;
  currentThinkingEffort?: string;
  currentProfile?: string;
  pendingPlanApproval: PendingPlanApproval | null;
  compactRequestPending: boolean;
  pendingManualCompact: boolean;
  /** True while the provider-neutral runtime reports an active compaction turn. */
  runtimeCompacting: boolean;
  currentProviderId: string;
  currentModelId: string;
  runtimeProvider: string;
  runtimeSessionId: string;
  mcpServers: McpServerStatus[] | null;
  supportsPromptReceipts: boolean;
  persistedLoaded: boolean;
  contextUsage: ContextUsageState | null;
  hasFileChanges: boolean;
  slashCommands: SlashCommand[];
  slashCommandsLoading: boolean;
  slashCommandsKey: string | null;
  slashCommandsRequestRef: string | null;
  todos: TodoItem[];
  featureTitle: string | null;
  isAutoNaming: boolean;
  pendingWsRequests: Map<string, (payload: unknown) => void>;
  worktreeStatus: WorktreeStatus;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeSetupOutput: string[];
  worktreeError: string | null;
  hasMore: boolean;
  oldestMessageId: number | null;
  /**
   * Highest DB message id this client has hydrated. Cursor for the
   * reconnect resync: after the socket drops (e.g. mobile sleep) we fetch
   * everything `after` this id so messages streamed while disconnected are
   * recovered. `null` until the first persisted load supplies one.
   */
  lastAppliedMessageId: number | null;
  featureId: number | null;
  sessionDbId: number | null;
  cwd: string | null;
  queuedPrompts: QueuedPrompt[];
  /**
   * Transport health for the agent stream (driven by
   * `session.stream_status`). Providers that do not support this stay at
   * `"ok"`. See `StreamHealth`.
   */
  streamHealth: StreamHealth;
}

export function createSessionEntry(): SessionEntry {
  return {
    conn: null,
    isConnected: false,
    serverSessionId: "",
    lifecycle: createIdleTurnLifecycle(),
    turnTiming: createTurnTiming(),
    streamingState: createStreamingState(),
    blocks: [],
    rootBlocks: [],
    toolResultMap: new Map(),
    historyPrependDisplayOffset: 0,
    pendingPermission: null,
    pendingPermissionQueue: [],
    pendingRequestId: "",
    submittingPermissionRequestId: null,
    pendingQuestions: [],
    pendingQuestionToolInput: {},
    permissionMode: defaultEditModeFor(DEFAULT_PROVIDER),
    codexPermissionMode: "default",
    currentThinkingEffort: undefined,
    pendingPlanApproval: null,
    compactRequestPending: false,
    pendingManualCompact: false,
    runtimeCompacting: false,
    currentProviderId: DEFAULT_PROVIDER,
    currentModelId: FALLBACK_MODEL_ID,
    runtimeProvider: DEFAULT_PROVIDER,
    runtimeSessionId: "",
    currentProfile: undefined,
    mcpServers: null,
    supportsPromptReceipts: false,
    persistedLoaded: false,
    contextUsage: null,
    hasFileChanges: false,
    slashCommands: [],
    slashCommandsLoading: false,
    slashCommandsKey: null,
    slashCommandsRequestRef: null,
    todos: [],
    featureTitle: null,
    isAutoNaming: false,
    pendingWsRequests: new Map(),
    worktreeStatus: "idle",
    worktreePath: null,
    worktreeBranch: null,
    worktreeSetupOutput: [],
    worktreeError: null,
    hasMore: false,
    oldestMessageId: null,
    lastAppliedMessageId: null,
    featureId: null,
    sessionDbId: null,
    cwd: null,
    queuedPrompts: [],
    streamHealth: createStreamHealth(),
  };
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/** A pending dirty-worktree confirmation for a rewind, surfaced as a dialog. */
export interface BranchConfirmState {
  /** Store key of the session being rewound. */
  sessionId: string;
  messageId: number;
  kind: "rewind";
  reason: string;
}

/** One-shot signal to prefill a session's composer with a rewound/forked draft. */
export interface ComposerPrefill {
  /** Store key of the session whose composer should receive the text. */
  sessionId: string;
  text: string;
  /** Bumped each time so an identical text still retriggers the effect. */
  nonce: number;
}

/**
 * One-shot signal to navigate the originating client to a freshly-forked
 * feature. The store can't navigate, so `forkFromMessage` parks the target here
 * and the source session's `AgentSession` effect performs the navigation.
 */
export interface ForkNavigation {
  /** Store key of the session that initiated the fork (only it navigates). */
  sessionId: string;
  projectId: number;
  featureId: number;
  /** Bumped each time so a repeat fork to the same feature still retriggers. */
  nonce: number;
}

export interface WsSessionStore {
  sessions: Record<string, SessionEntry>;

  /** Set while a rewind awaits the user's confirmation to discard changes. */
  branchConfirm: BranchConfirmState | null;
  /** Set to push a draft into the target session's composer, then consumed. */
  composerPrefill: ComposerPrefill | null;
  /** Set to navigate the originating client to a just-forked feature, then consumed. */
  forkNavigation: ForkNavigation | null;

  connect: (sessionId: string) => void;
  disconnect: (sessionId: string) => void;

  send: (sessionId: string, data: unknown) => void;
  initSession: (sessionId: string, config: SessionConfig) => void;
  sendPrompt: (sessionId: string, text: string, options?: PromptDispatchOptions) => void;
  respondToPermission: (
    sessionId: string,
    requestId: string,
    decision: PermissionDecisionValue,
    feedback?: string,
    optionId?: string,
  ) => void;
  respondToQuestion: (sessionId: string, response: AgentQuestionAnswers) => void;
  interrupt: (sessionId: string) => void;
  destroy: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  /** Rewind conversation + code back to before `messageId`, in place. */
  rewindToMessage: (sessionId: string, messageId: number, confirmDiscard?: boolean) => void;
  /** Fork the conversation into a new session at `messageId` (same worktree). */
  forkFromMessage: (sessionId: string, messageId: number) => void;
  /** Resolve a pending `branchConfirm` (re-runs the rewind when confirmed). */
  resolveBranchConfirm: (confirmed: boolean) => void;
  /** Clear `composerPrefill` once the target composer has applied it. */
  consumeComposerPrefill: (sessionId: string) => void;
  /** Clear `forkNavigation` once the source session has navigated to the fork. */
  consumeForkNavigation: (sessionId: string) => void;
  compactSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setProvider: (sessionId: string, providerId: string) => void;
  setModel: (sessionId: string, modelId: string) => void;
  setThinkingEffort: (sessionId: string, thinkingEffort?: string) => void;
  setProfile: (sessionId: string, profile: string) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  setCodexPermissionMode: (sessionId: string, mode: CodexPermissionMode) => void;
  approvePlan: (sessionId: string) => void;
  requestPlanChanges: (sessionId: string, feedback: string) => void;
  closeGate: (sessionId: string, reason: GateCloseReason) => void;

  sendRequest: (sessionId: string, envelope: WsEnvelope) => Promise<unknown>;

  retryWorktreeSetup: (sessionId: string) => void;
  requestSlashCommands: (sessionId: string, cwd: string, provider: string) => void;

  markPersistedLoaded: (sessionId: string) => void;
  setPersistedState: (sessionId: string, options: PersistedStatePayload) => void;
  /**
   * Loads older messages for a session. Resolves with the number of blocks
   * prepended to the conversation. The store also increments
   * `historyPrependDisplayOffset` by the rendered row count for Virtuoso.
   */
  loadOlderMessages: (sessionId: string) => Promise<number>;
  /**
   * Pull any messages persisted after the newest block we hold and merge them
   * in — the same catch-up path used on WS reconnect. Used after a manual
   * "Sync from CLI" appends events to the session on the backend.
   */
  refreshSessionMessages: (sessionId: string, target?: ResyncTarget) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function updateSession(
  state: Pick<WsSessionStore, "sessions">,
  sessionId: string,
  patch: Partial<SessionEntry>,
): Partial<WsSessionStore> {
  const prev = state.sessions[sessionId];
  if (!prev) return {};
  const normalizedPatch = normalizeSessionPatch(prev, patch);
  const next = { ...prev, ...normalizedPatch };
  // Recompute timing on a lifecycle change UNLESS the caller supplied its own
  // `turnTiming` (e.g. a status-driven sync anchoring the timer to the
  // server-stamped turn start) — honoring it keeps all devices in sync.
  if (
    normalizedPatch.lifecycle &&
    normalizedPatch.turnTiming === undefined &&
    lifecycleChanged(prev.lifecycle, normalizedPatch.lifecycle)
  ) {
    next.turnTiming = transitionTurnTiming(
      prev.turnTiming,
      prev.lifecycle,
      normalizedPatch.lifecycle,
    );
  }
  if (shouldAppendTurnSummary(prev.lifecycle, next.lifecycle, next.turnTiming, next.blocks)) {
    const blocks = [...next.blocks, buildTurnSummaryBlock(next.turnTiming)];
    Object.assign(next, blocksPatchWithDerived(next.streamingState, blocks));
  }
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: next,
    },
  };
}

function normalizeSessionPatch(
  prev: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  if (
    patch.lifecycle?.phase === "terminal" &&
    patch.lifecycle.reason === "completed" &&
    isEmptyUserPausedSettlement(prev, patch.blocks ?? prev.blocks)
  ) {
    return { ...patch, lifecycle: createIdleTurnLifecycle() };
  }
  return patch;
}

function isEmptyUserPausedSettlement(session: SessionEntry, blocks: AgentBlockData[]): boolean {
  return (
    session.lifecycle.phase === "paused" &&
    session.lifecycle.reason === "user" &&
    blocks.length === 0
  );
}

function lifecycleChanged(previous: TurnLifecycle, next: TurnLifecycle): boolean {
  if (previous.phase !== next.phase) return true;
  if (previous.phase === "paused" && next.phase === "paused")
    return previous.reason !== next.reason;
  if (previous.phase === "terminal" && next.phase === "terminal") {
    return previous.reason !== next.reason;
  }
  if (previous.phase === "error" && next.phase === "error")
    return previous.message !== next.message;
  return false;
}

function shouldAppendTurnSummary(
  previous: TurnLifecycle,
  next: TurnLifecycle,
  timing: TurnTimingState,
  blocks: AgentBlockData[],
): boolean {
  return (
    previous.phase !== "terminal" &&
    next.phase === "terminal" &&
    timing.completed != null &&
    blocks.at(-1)?.type !== "turn_summary"
  );
}

function buildTurnSummaryBlock(timing: TurnTimingState): AgentBlockData {
  const completed = timing.completed ?? {
    totalMs: 0,
    activeMs: 0,
    userPendingMs: 0,
  };
  const content = [
    `Worked - ${formatTurnDuration(completed.totalMs)}`,
    `Agent ${formatTurnDuration(completed.activeMs)}`,
    `Waiting ${formatTurnDuration(completed.userPendingMs)}`,
  ].join(" · ");
  return {
    id: `turn-summary-${Date.now()}`,
    type: "turn_summary",
    content,
    isError: false,
    createdAt: new Date().toISOString(),
  };
}

export function markLastPlanBlock(
  blocks: AgentBlockData[],
  status: "approved" | "rejected",
): AgentBlockData[] {
  const lastIdx = blocks.findLastIndex(
    (b) =>
      b.type === "tool_call" &&
      (b.toolName === "ExitPlanMode" || isCadencrPlanPresentationTool(b.toolName)),
  );
  if (lastIdx === -1) return blocks;
  const updated = [...blocks];
  updated[lastIdx] = { ...updated[lastIdx], planApprovalStatus: status };
  return updated;
}
