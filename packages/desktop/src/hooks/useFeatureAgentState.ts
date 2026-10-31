/**
 * Single hook that provides all agent state for a feature.
 *
 * Data flows through a single path:
 *   1. `useGetFeatureAgentState` — canonical state from DB (pre-built nested blocks)
 *   2. React Query polling and WebSocket events drive refetches
 *
 * Incremental fetching: after the first full load, subsequent fetches only request
 * messages newer than what we already have (via `afterMessageIds`). The server returns
 * partial blocks that are merged into the accumulated state on the client.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useGetFeatureAgentState,
  getFeatureAgentState,
  type FeatureAgentStateResponse,
} from "../api/generated";
import { useAgentStateIdbCache } from "./useAgentStateIdbCache";
import {
  applyToolCallUpdates,
  buildToolUseIdMap,
  mergeIncrementalBlocks,
  serverBlocksToAgentBlocks,
  type AccumulatedSession,
} from "./useFeatureAgentState-merge";
import type { AgentBlockData } from "@/types/agent-block";
import type { AgentType } from "../types/agent-types";
import { normalizeContextWindow, type AgentStatus, type TodoItem } from "@/types/agent";
import { parseAskUserQuestions } from "@/lib/agent-question-parser";
import type { AgentQuestion } from "@/types/agent-question";
import type { PendingPermission } from "@/types/agent-permission";
import { parsePermissionMode, type PermissionMode } from "@/types/permission-mode";
import { parseAccessMode, type AccessMode } from "@/types/access-mode";
import {
  AGENT_STATE_INITIAL_MESSAGE_LIMIT,
  AGENT_STATE_OLDER_MESSAGE_LIMIT,
} from "@/lib/agent-state-limits";

export { serverBlocksToAgentBlocks };

// ---------------------------------------------------------------------------
// Session shape exposed to consumers
// ---------------------------------------------------------------------------

// Re-exported from @/types/agent
export type { TodoItem } from "@/types/agent";

export interface FeatureSession {
  sessionDbId: number;
  agentType: AgentType;
  status: AgentStatus;
  subprocessId: string | null;
  model: string | null;
  profile: string | null;
  blocks: AgentBlockData[];
  pendingQuestions: AgentQuestion[] | null;
  hasFileChanges: boolean;
  resumable: boolean;
  runtimeProvider?: string | null;
  runtimeSessionId: string | null;
  todos: TodoItem[] | null;
  permissionMode: PermissionMode;
  accessMode: AccessMode;
  pendingPermission: PendingPermission | null;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number | null;
  wasCompacted: boolean;
  draftPrompt: string | null;
  hasMore: boolean;
  oldestMessageId: number | null;
}

type FeatureSessionOptionalField =
  | "runtimeProvider"
  | "runtimeSessionId"
  | "draftPrompt"
  | "profile";

function getOptionalSessionString(
  session: object,
  key: FeatureSessionOptionalField,
): string | null {
  const value = (session as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

type ServerSession = FeatureAgentStateResponse["sessions"][number];

function parseQuestions(raw: unknown): AgentQuestion[] | null {
  if (!raw || typeof raw !== "object") return null;
  const result = parseAskUserQuestions(raw as Record<string, unknown>);
  return result.length > 0 ? result : null;
}

function mergeServerSession(
  accumulated: Map<number, AccumulatedSession>,
  session: ServerSession,
): void {
  const newBlocks = serverBlocksToAgentBlocks(session.blocks);
  let current = accumulated.get(session.sessionDbId);
  if (!session.isIncremental || !current) {
    current = {
      blocks: newBlocks,
      maxMessageId: session.maxMessageId,
      toolUseIdMap: buildToolUseIdMap(newBlocks),
      todos: (session.todos as TodoItem[] | null) ?? null,
      hasMore: session.hasMore ?? false,
      oldestMessageId: session.oldestMessageId ?? null,
    };
    accumulated.set(session.sessionDbId, current);
    return;
  }
  if (newBlocks.length > 0) {
    mergeIncrementalBlocks(current, newBlocks);
    current.blocks = [...current.blocks];
  }
  if (session.maxMessageId > current.maxMessageId) current.maxMessageId = session.maxMessageId;
  const updates = applyToolCallUpdates(
    current.blocks,
    session.toolCallUpdates,
    new Set(session.truncatedToolCallUpdateIds ?? []),
  );
  if (updates !== current.blocks) {
    current.blocks = updates;
    current.toolUseIdMap = buildToolUseIdMap(updates);
  }
  if (session.todos != null) current.todos = session.todos as TodoItem[];
}

function reconcileAccumulatedSessions(
  accumulated: Map<number, AccumulatedSession>,
  serverSessions: ServerSession[],
): void {
  const currentSessionIds = new Set(serverSessions.map((session) => session.sessionDbId));
  for (const sessionId of accumulated.keys()) {
    if (!currentSessionIds.has(sessionId)) accumulated.delete(sessionId);
  }
  for (const session of serverSessions) mergeServerSession(accumulated, session);
}

function toFeatureSession(
  session: ServerSession,
  accumulated: AccumulatedSession | undefined,
): FeatureSession {
  const status: AgentStatus =
    session.status === "running" ||
    session.status === "paused" ||
    session.status === "completed" ||
    session.status === "error"
      ? session.status
      : session.status === "waiting"
        ? "paused"
        : "idle";
  return {
    sessionDbId: session.sessionDbId,
    agentType: session.agentType as AgentType,
    status,
    subprocessId: session.subprocessId ?? null,
    model: session.model ?? null,
    profile: getOptionalSessionString(session, "profile"),
    blocks: accumulated?.blocks ?? serverBlocksToAgentBlocks(session.blocks),
    pendingQuestions: parseQuestions(session.pendingQuestions),
    hasFileChanges: session.hasFileChanges,
    resumable: session.resumable,
    runtimeProvider: getOptionalSessionString(session, "runtimeProvider"),
    runtimeSessionId: session.runtimeSessionId ?? null,
    todos: (session.todos as TodoItem[] | null) ?? accumulated?.todos ?? null,
    permissionMode: parsePermissionMode(session.permissionMode) ?? "acceptEdits",
    accessMode: parseAccessMode(session.accessMode),
    pendingPermission: (session.pendingPermission as PendingPermission | null) ?? null,
    inputTokens: session.inputTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
    contextWindow: normalizeContextWindow(session.contextWindow),
    wasCompacted: session.wasCompacted ?? false,
    draftPrompt: getOptionalSessionString(session, "draftPrompt"),
    hasMore: accumulated?.hasMore ?? session.hasMore ?? false,
    oldestMessageId: accumulated?.oldestMessageId ?? session.oldestMessageId ?? null,
  };
}

function registerOlderToolCalls(accumulated: AccumulatedSession, blocks: AgentBlockData[]): void {
  for (const block of blocks) {
    if (block.type === "tool_call" && block.toolUseId) {
      accumulated.toolUseIdMap.set(block.toolUseId, {
        toolName: block.toolName ?? "tool",
        block,
      });
    }
    for (const child of block.childBlocks ?? []) {
      if (child.type === "tool_call" && child.toolUseId) {
        accumulated.toolUseIdMap.set(child.toolUseId, {
          toolName: child.toolName ?? "tool",
          block: child,
        });
      }
    }
  }
}

function useLoadOlderMessages(
  featureId: number,
  accumulatedRef: RefObject<Map<number, AccumulatedSession>>,
  setOlderHistoryVersion: Dispatch<SetStateAction<number>>,
): (sessionDbId: number) => Promise<void> {
  return useCallback(
    async (sessionDbId: number) => {
      const accumulated = accumulatedRef.current.get(sessionDbId);
      if (!accumulated?.hasMore || accumulated.oldestMessageId == null) return;
      const data = await getFeatureAgentState(featureId, {
        before: JSON.stringify({ [sessionDbId]: accumulated.oldestMessageId }),
        limit: AGENT_STATE_OLDER_MESSAGE_LIMIT,
      });
      const serverSession = data.sessions.find((session) => session.sessionDbId === sessionDbId);
      if (!serverSession) return;
      const olderBlocks = serverBlocksToAgentBlocks(serverSession.blocks);
      if (olderBlocks.length === 0) {
        accumulated.hasMore = false;
        return;
      }
      registerOlderToolCalls(accumulated, olderBlocks);
      accumulated.blocks = [...olderBlocks, ...accumulated.blocks];
      accumulated.hasMore = serverSession.hasMore ?? false;
      accumulated.oldestMessageId = serverSession.oldestMessageId ?? null;
      setOlderHistoryVersion((version) => version + 1);
    },
    [accumulatedRef, featureId, setOlderHistoryVersion],
  );
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useFeatureAgentState(featureId: number) {
  const accumulatedRef = useRef(new Map<number, AccumulatedSession>());
  // dataVersion is incremented after processing new query data so that
  // afterMessageIds recomputes and the next fetch uses incremental cursors.
  const [dataVersion, setDataVersion] = useState(0);
  const [olderHistoryVersion, setOlderHistoryVersion] = useState(0);

  // Reset accumulated state when feature changes (synchronous, not useEffect,
  // to avoid clearing the ref after useMemo populates it on the same render).
  const prevFeatureIdRef = useRef(featureId);
  if (prevFeatureIdRef.current !== featureId) {
    accumulatedRef.current = new Map();
    prevFeatureIdRef.current = featureId;
  }

  // Derive afterMessageIds from the accumulated state.
  // dataVersion is read to ensure this recomputes after processing new data.
  // React Query serializes the input for cache keying, so a new object with
  // the same values produces the same key (no spurious refetches).
  void dataVersion;
  let afterMessageIds: Record<string, number> | undefined;
  if (accumulatedRef.current.size > 0) {
    afterMessageIds = {};
    for (const [sid, acc] of accumulatedRef.current) {
      afterMessageIds[String(sid)] = acc.maxMessageId;
    }
  }

  const afterParam = afterMessageIds ? JSON.stringify(afterMessageIds) : undefined;
  // Only apply limit on initial load (no afterMessageIds yet)
  const initialLimit = afterMessageIds ? undefined : AGENT_STATE_INITIAL_MESSAGE_LIMIT;
  const query = useGetFeatureAgentState(
    featureId,
    { after: afterParam, limit: initialLimit },
    { query: { placeholderData: keepPreviousData } },
  );

  // Track which query.data we last processed to guard against React strict mode
  // calling useMemo twice with the same input (which would double-append blocks).
  const lastProcessedDataRef = useRef<unknown>(null);

  // Process query data: merge incremental blocks into accumulated state
  const sessions: FeatureSession[] = useMemo(() => {
    const serverSessions = query.data?.sessions ?? [];
    if (serverSessions.length === 0 && accumulatedRef.current.size === 0) return [];
    if (query.data !== lastProcessedDataRef.current) {
      lastProcessedDataRef.current = query.data;
      reconcileAccumulatedSessions(accumulatedRef.current, serverSessions);
    }
    return serverSessions.map((session) =>
      toFeatureSession(session, accumulatedRef.current.get(session.sessionDbId)),
    );
  }, [olderHistoryVersion, query.data]);

  // After processing new data, bump dataVersion so afterMessageIds recomputes
  // on the next render and subsequent fetches use incremental cursors.
  useEffect(() => {
    if (query.data && query.data.sessions.length > 0) {
      setDataVersion((v) => v + 1);
    }
  }, [query.data]);

  // IDB hydrate (read-only) + write-back of the latest successful fetch.
  // The hook seeds React Query before the network round-trips so cold opens
  // paint immediately on re-open. Gated on `prevFeatureIdRef` so switching
  // features never paints the previous feature's cached blocks.
  useAgentStateIdbCache(featureId, query.data, prevFeatureIdRef, AGENT_STATE_INITIAL_MESSAGE_LIMIT);

  const loadOlderMessages = useLoadOlderMessages(featureId, accumulatedRef, setOlderHistoryVersion);

  return {
    sessions,
    isLoading: query.isLoading,
    refetch: query.refetch,
    loadOlderMessages,
  };
}
