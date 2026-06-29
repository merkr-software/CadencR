/**
 * WebSocket session hook — thin wrapper over the Zustand ws-session-store.
 *
 * The store owns WebSocket connections and all per-session state so that
 * navigating away and back does NOT create a new connection.
 */

import { useEffect, useMemo } from "react";
import { DEFAULT_PROVIDER, FALLBACK_MODEL_ID } from "../shared/models";
import type { AgentBlockData } from "@/components/AgentBlock";
import { useGetFeatureAgentState } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import {
  useWsSessionStore,
  type PermissionMode,
  type PendingPlanApproval,
} from "@/stores/ws-session-store";
import type { PendingPermission } from "@/components/ToolPermissionPrompt";
import type { PermissionDecisionValue } from "@/components/ToolPermissionPrompt";
import type { AgentQuestion, AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import type { GateCloseReason, PromptDispatchOptions, SessionConfig } from "@/lib/ws-envelope";
import { normalizeContextWindow, type ContextUsageState } from "@/types/agent";
import type { LiveAgentStatus } from "@/types/agent";
import {
  type TurnLifecycle,
  createIdleTurnLifecycle,
  persistedSessionToLifecycle,
} from "@/stores/ws-turn-lifecycle";
import { createTurnTiming, type TurnTimingState } from "@/stores/ws-turn-timing";
import { useSessionStatus } from "@/stores/session-status-selectors";
import { liveStatusFromLifecycle } from "@/lib/agent-status";
import { AGENT_STATE_INITIAL_MESSAGE_LIMIT } from "@/lib/agent-state-limits";
import { parseCodexPermissionMode, type CodexPermissionMode } from "@/types/codex-permission-mode";
import { parsePermissionMode } from "@/types/permission-mode";
import type { McpServerStatus, SessionEntry } from "@/stores/ws-session-types";

export interface UseWebSocketSessionReturn {
  blocks: AgentBlockData[];
  /** Pre-filtered subset of `blocks` excluding subagent children, maintained
   *  incrementally by the store so AgentStream avoids re-deriving it on
   *  every chunk. */
  rootBlocks: AgentBlockData[];
  /** Map from a tool_call's `toolUseId` to its `tool_result` block, also
   *  maintained incrementally by the store. */
  toolResultMap: Map<string, AgentBlockData>;
  /** Rendered Virtuoso row count prepended by older-history pagination. */
  historyPrependDisplayOffset: number;
  lifecycle: TurnLifecycle;
  turnTiming: TurnTimingState;
  status: LiveAgentStatus;
  /** True while any backend-confirmed compaction is in progress.
   *  Manual compaction is driven by `compact.started`; runtime/auto compaction
   *  is driven by `session.compacting`. Drives the "Compacting…" indicator. */
  isCompacting: boolean;
  isConnected: boolean;
  sessionId: string;
  sessionDbId: number | null;
  pendingPermission: PendingPermission | null;
  pendingRequestId: string;
  /**
   * True while a decision for the currently visible permission request is in
   * flight to the backend (between click and ack). Used to show a loader and
   * disable buttons in `ToolPermissionPrompt`.
   */
  isSubmittingPermission: boolean;
  pendingQuestions: AgentQuestion[];
  respondToQuestion: (response: AgentQuestionAnswers) => void;
  hasMore: boolean;
  /** Resolves with the number of older blocks that were prepended. */
  loadOlderMessages: () => Promise<number>;

  permissionMode: PermissionMode;
  codexPermissionMode: CodexPermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  setCodexPermissionMode: (mode: CodexPermissionMode) => void;
  pendingPlanApproval: PendingPlanApproval | null;
  approvePlan: () => void;
  requestPlanChanges: (feedback: string) => void;
  closeGate: (reason: GateCloseReason) => void;

  contextUsage: ContextUsageState | null;
  currentProviderId: string;
  currentModelId: string;
  currentThinkingEffort?: string;
  currentProfile?: string;
  runtimeProvider: string;
  runtimeSessionId: string;
  mcpServers: McpServerStatus[] | null;
  hasFileChanges: boolean;
  setModel: (modelId: string) => void;
  setThinkingEffort: (thinkingEffort?: string) => void;
  setProfile: (profile: string) => void;
  setProvider: (providerId: string) => void;
  sendPrompt: (text: string, options?: PromptDispatchOptions) => void;
  respondToPermission: (
    requestId: string,
    decision: PermissionDecisionValue,
    feedback?: string,
    optionId?: string,
  ) => void;
  interrupt: () => void;
  destroy: () => void;
  clearSession: () => void;
  compactSession: () => void;
  initSession: (config: SessionConfig) => void;
}

interface UseWebSocketSessionOptions {
  loadPersisted?: boolean;
}

type SessionActions = Pick<
  UseWebSocketSessionReturn,
  | "loadOlderMessages"
  | "sendPrompt"
  | "respondToPermission"
  | "respondToQuestion"
  | "interrupt"
  | "destroy"
  | "clearSession"
  | "compactSession"
  | "initSession"
  | "setProvider"
  | "setModel"
  | "setThinkingEffort"
  | "setProfile"
  | "setPermissionMode"
  | "setCodexPermissionMode"
  | "approvePlan"
  | "requestPlanChanges"
  | "closeGate"
>;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebSocketSession(
  sessionId: string,
  featureId?: number,
  options?: UseWebSocketSessionOptions,
): UseWebSocketSessionReturn {
  // Subscribe to this session's slice only — chunks on other sessions don't
  // re-render the hook.
  const session = useWsSessionStore((s) => s.sessions[sessionId]);

  // Backend-driven status (the single source of truth — see
  // `domain::session_status` on the Rust side and `session-status-store`
  // on the frontend). Keyed by the DB session id, which the WS handler
  // populates on `session.connected` / persistedLoaded.
  const sessionDbId = session?.sessionDbId ?? null;
  const liveStatus = useSessionStatus(sessionDbId)?.status ?? null;

  useEffect(() => {
    useWsSessionStore.getState().connect(sessionId);
    // Connections are cached; no disconnect on unmount.
  }, [sessionId]);

  usePersistedSessionLoader(session, sessionId, featureId, options);
  const actions = useSessionActions(sessionId);
  return useSessionSnapshot(session, sessionId, actions, liveStatus);
}

function usePersistedSessionLoader(
  session: SessionEntry | undefined,
  sessionId: string,
  featureId: number | undefined,
  options: UseWebSocketSessionOptions | undefined,
): void {
  const loadPersisted = options?.loadPersisted ?? true;
  const persistedLoaded = session?.persistedLoaded ?? false;
  const persistedStateParams = useMemo(() => ({ limit: AGENT_STATE_INITIAL_MESSAGE_LIMIT }), []);
  const agentStateQuery = useGetFeatureAgentState(featureId ?? 0, persistedStateParams, {
    query: {
      enabled: loadPersisted && !!featureId && !persistedLoaded,
      cacheTime: 0,
    },
  });

  useEffect(() => {
    if (persistedLoaded || !featureId) return;
    const store = useWsSessionStore.getState();
    // Settle the gate even when the snapshot fetch fails so a transient REST
    // error can't permanently block `session.init` (the auto-init effect now
    // waits on `persistedLoaded`).
    if (agentStateQuery.isError) {
      store.markPersistedLoaded(sessionId);
      return;
    }
    if (!agentStateQuery.data) return;
    const sessions = agentStateQuery.data.sessions;
    if (sessions.length === 0) {
      store.markPersistedLoaded(sessionId);
      return;
    }

    const lastSession = sessions[sessions.length - 1];
    const restoredBlocks = serverBlocksToAgentBlocks(lastSession.blocks);

    const restoredLifecycle = persistedSessionToLifecycle(lastSession);

    const persistedContextUsage: ContextUsageState | null =
      lastSession.inputTokens > 0 ||
      lastSession.outputTokens > 0 ||
      normalizeContextWindow(lastSession.contextWindow) != null
        ? {
            inputTokens: lastSession.inputTokens ?? 0,
            outputTokens: lastSession.outputTokens ?? 0,
            contextWindow: normalizeContextWindow(lastSession.contextWindow),
            wasCompacted: lastSession.wasCompacted ?? false,
          }
        : null;
    store.setPersistedState(sessionId, {
      blocks: restoredBlocks,
      lifecycle: restoredLifecycle,
      hasMore: lastSession.hasMore,
      oldestMessageId: lastSession.oldestMessageId,
      maxMessageId: lastSession.maxMessageId,
      featureId,
      sessionDbId: lastSession.sessionDbId,
      currentProviderId: lastSession.runtimeProvider ?? undefined,
      currentModelId: lastSession.model ?? undefined,
      currentProfile: lastSession.profile ?? undefined,
      permissionMode: parsePermissionMode(lastSession.permissionMode) ?? undefined,
      codexPermissionMode: parseCodexPermissionMode(lastSession.codexPermissionMode),
      runtimeProvider: lastSession.runtimeProvider ?? undefined,
      runtimeSessionId: lastSession.runtimeSessionId ?? undefined,
      pendingPermission: lastSession.pendingPermission,
      pendingQuestions: lastSession.pendingQuestions,
      contextUsage: persistedContextUsage,
      hasFileChanges: lastSession.hasFileChanges,
    });
  }, [featureId, agentStateQuery.data, agentStateQuery.isError, persistedLoaded, sessionId]);
}

function useSessionActions(sessionId: string): SessionActions {
  return useMemo<SessionActions>(() => {
    const s = useWsSessionStore.getState();
    return {
      loadOlderMessages: (): Promise<number> => s.loadOlderMessages(sessionId),
      sendPrompt: (text: string, options?: PromptDispatchOptions): void =>
        s.sendPrompt(sessionId, text, options),
      respondToPermission: (
        requestId: string,
        decision: PermissionDecisionValue,
        feedback?: string,
        optionId?: string,
      ): void => s.respondToPermission(sessionId, requestId, decision, feedback, optionId),
      respondToQuestion: (response: AgentQuestionAnswers): void =>
        s.respondToQuestion(sessionId, response),
      interrupt: (): void => s.interrupt(sessionId),
      destroy: (): void => s.destroy(sessionId),
      clearSession: (): void => s.clearSession(sessionId),
      compactSession: (): void => s.compactSession(sessionId),
      initSession: (config: SessionConfig): void => s.initSession(sessionId, config),
      setProvider: (providerId: string): void => s.setProvider(sessionId, providerId),
      setModel: (modelId: string): void => s.setModel(sessionId, modelId),
      setThinkingEffort: (thinkingEffort?: string): void =>
        s.setThinkingEffort(sessionId, thinkingEffort),
      setProfile: (profile: string): void => s.setProfile(sessionId, profile),
      setPermissionMode: (mode: PermissionMode): void => s.setPermissionMode(sessionId, mode),
      setCodexPermissionMode: (mode: CodexPermissionMode): void =>
        s.setCodexPermissionMode(sessionId, mode),
      approvePlan: (): void => s.approvePlan(sessionId),
      requestPlanChanges: (feedback: string): void => s.requestPlanChanges(sessionId, feedback),
      closeGate: (reason: GateCloseReason): void => s.closeGate(sessionId, reason),
    };
  }, [sessionId]);
}

function useSessionSnapshot(
  session: SessionEntry | undefined,
  sessionId: string,
  actions: SessionActions,
  liveStatus: LiveAgentStatus | null,
): UseWebSocketSessionReturn {
  return useMemo<UseWebSocketSessionReturn>(() => {
    const lifecycle = session?.lifecycle ?? createIdleTurnLifecycle();
    // Status is the backend-pushed value when available. Until the
    // first `session_status.update` arrives (race during initial WS
    // connect, or before `sessionDbId` is known), fall back to deriving
    // from the local lifecycle so the UI doesn't blink to Idle on
    // mount. Once the WS snapshot arrives, `liveStatus` wins forever —
    // see `lib/agent-status.ts` for the canonical mapping.
    const status: LiveAgentStatus = liveStatus ?? liveStatusFromLifecycle(lifecycle);
    return {
      blocks: session?.blocks ?? [],
      rootBlocks: session?.rootBlocks ?? [],
      toolResultMap: session?.toolResultMap ?? new Map(),
      historyPrependDisplayOffset: session?.historyPrependDisplayOffset ?? 0,
      lifecycle,
      turnTiming: session?.turnTiming ?? createTurnTiming(),
      status,
      isCompacting:
        (session?.pendingManualCompact ?? false) || (session?.runtimeCompacting ?? false),
      isConnected: session?.isConnected ?? false,
      sessionId,
      sessionDbId: session?.sessionDbId ?? null,
      hasMore: session?.hasMore ?? false,
      pendingPermission: session?.pendingPermission ?? null,
      pendingRequestId: session?.pendingRequestId ?? "",
      // Scope the boolean to the currently visible request so a stale clear
      // never lights up the spinner on the next queued permission.
      isSubmittingPermission:
        session?.submittingPermissionRequestId != null &&
        session.submittingPermissionRequestId ===
          (session.pendingPermission?.requestId ?? session.pendingRequestId),
      pendingQuestions: session?.pendingQuestions ?? [],
      permissionMode: session?.permissionMode ?? "acceptEdits",
      codexPermissionMode: session?.codexPermissionMode ?? "default",
      pendingPlanApproval: session?.pendingPlanApproval ?? null,
      contextUsage: session?.contextUsage ?? null,
      currentProviderId: session?.currentProviderId ?? DEFAULT_PROVIDER,
      currentModelId: session?.currentModelId ?? FALLBACK_MODEL_ID,
      currentThinkingEffort: session?.currentThinkingEffort,
      currentProfile: session?.currentProfile,
      runtimeProvider: session?.runtimeProvider ?? DEFAULT_PROVIDER,
      runtimeSessionId: session?.runtimeSessionId ?? "",
      mcpServers: session?.mcpServers ?? null,
      hasFileChanges: session?.hasFileChanges ?? false,
      ...actions,
    };
  }, [session, sessionId, actions, liveStatus]);
}
