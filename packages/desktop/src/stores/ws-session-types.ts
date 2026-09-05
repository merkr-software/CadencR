/**
 * Types and helpers for WebSocket session state.
 */

import type { AgentBlockData } from "@/components/AgentBlock";
import { isCadencrPlanPresentationTool } from "@/lib/tool-call-parser";
import type { TodoItem } from "@/types/agent";
import type { ContextUsageState } from "@/types/agent";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";
import type { AgentQuestion } from "@/components/AgentQuestionDrawer";
import type { SlashCommand } from "@/lib/slash-command";
import {
  DEFAULT_PROMPT_COMMAND_POLICY,
  type PromptCommandPolicy,
} from "@/lib/prompt-command-policy";
import type { WorktreeStatus } from "@/types/workflow";
import type { WsConnection } from "@/lib/ws-connection";
import type { FirstPromptBranchSetup, WsEnvelope } from "@/lib/ws-envelope";
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
import { DEFAULT_PROVIDER } from "../shared/models";
import type { RuntimeSelection } from "../shared/models";
import { defaultEditModeFor } from "../lib/provider-modes";
import type { PermissionMode } from "../types/permission-mode";
import type { AccessMode } from "@/types/access-mode";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type { RuntimeSessionConfigSnapshot } from "@/api/generated";

export type { PermissionMode };

export interface SessionConfigState {
  sessionConfig: RuntimeSessionConfigSnapshot | null;
  sessionConfigLoading: boolean;
  sessionConfigSupported: boolean | null;
  sessionConfigError: string | null;
  pendingSessionConfigId: string | null;
}

export function createSessionConfigState(): SessionConfigState {
  return {
    sessionConfig: null,
    sessionConfigLoading: false,
    sessionConfigSupported: null,
    sessionConfigError: null,
    pendingSessionConfigId: null,
  };
}

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
  currentSelection?: RuntimeSelection;
  currentThinkingEffort?: string;
  currentProfile?: string;
  currentModelId?: string;
  permissionMode?: PermissionMode;
  accessMode?: AccessMode;
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
  messageUuid: string;
  attachments?: PromptAttachmentPayload[];
  branchSetup?: FirstPromptBranchSetup;
  claudeProfile?: string;
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

export interface SessionEntry extends SessionConfigState {
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
  /** Stable idempotency keys retained while permission responses may be retried. */
  permissionResponseMessageUuids: Map<string, string>;
  pendingQuestions: AgentQuestion[];
  pendingQuestionToolInput: Record<string, unknown>;
  permissionMode: PermissionMode;
  accessMode: AccessMode;
  currentThinkingEffort?: string;
  fastMode: boolean;
  currentProfile?: string;
  pendingPlanApproval: PendingPlanApproval | null;
  compactRequestPending: boolean;
  pendingManualCompact: boolean;
  /** True while the provider-neutral runtime reports an active compaction turn. */
  runtimeCompacting: boolean;
  /**
   * The session's runtime provider/model pair, or `null` while the backend has
   * not confirmed one. Written whole or not at all — no code path may update
   * one half, which is what allowed an opencode model to render under a Claude
   * provider. Never seeded: `null` renders a loading state, not a guess.
   */
  currentSelection: RuntimeSelection | null;
  runtimeSessionId: string;
  mcpServers: McpServerStatus[] | null;
  supportsPromptReceipts: boolean;
  persistedLoaded: boolean;
  contextUsage: ContextUsageState | null;
  hasFileChanges: boolean;
  slashCommands: SlashCommand[];
  promptCommandPolicy: PromptCommandPolicy;
  slashCommandsLoading: boolean;
  slashCommandsKey: string | null;
  slashCommandsRequestRef: string | null;
  todos: TodoItem[];
  featureTitle: string | null;
  isAutoNaming: boolean;
  pendingWsRequests: Map<string, (payload: unknown) => void>;
  /**
   * Envelopes that could not be sent because the socket was not OPEN
   * (reconnecting after a drop, or still CONNECTING). Flushed in order once
   * the transport is back, right after the reconnect `session.init` replay.
   * Mutated in place (like `pendingWsRequests`) — transport plumbing, not
   * render state.
   */
  outboundQueue: WsEnvelope[];
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
    permissionResponseMessageUuids: new Map(),
    pendingQuestions: [],
    pendingQuestionToolInput: {},
    permissionMode: defaultEditModeFor(DEFAULT_PROVIDER),
    accessMode: "default",
    currentThinkingEffort: undefined,
    fastMode: false,
    pendingPlanApproval: null,
    compactRequestPending: false,
    pendingManualCompact: false,
    runtimeCompacting: false,
    currentSelection: null,
    runtimeSessionId: "",
    ...createSessionConfigState(),
    currentProfile: undefined,
    mcpServers: null,
    supportsPromptReceipts: false,
    persistedLoaded: false,
    contextUsage: null,
    hasFileChanges: false,
    slashCommands: [],
    promptCommandPolicy: DEFAULT_PROMPT_COMMAND_POLICY,
    slashCommandsLoading: false,
    slashCommandsKey: null,
    slashCommandsRequestRef: null,
    todos: [],
    featureTitle: null,
    isAutoNaming: false,
    pendingWsRequests: new Map(),
    outboundQueue: [],
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

export type {
  BranchConfirmState,
  ComposerPrefill,
  ForkNavigation,
  WsSessionStore,
} from "./ws-session-store-types";
import type { WsSessionStore } from "./ws-session-store-types";

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
