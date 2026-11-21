import type { FeatureAgentStateResponse } from "@/api/generated";
import { serverBlocksToAgentBlocks } from "@/hooks/useFeatureAgentState";
import type { PersistedStatePayload } from "@/stores/ws-session-types";
import { persistedSessionToLifecycle } from "@/stores/ws-turn-lifecycle";
import { parseAccessMode } from "@/types/access-mode";
import { normalizeContextWindow, type ContextUsageState } from "@/types/agent";
import { parsePermissionMode } from "@/types/permission-mode";

type PersistedSession = FeatureAgentStateResponse["sessions"][number];

function persistedContextUsage(session: PersistedSession): ContextUsageState | null {
  const contextWindow = normalizeContextWindow(session.contextWindow);
  if (session.inputTokens <= 0 && session.outputTokens <= 0 && contextWindow == null) return null;
  return {
    inputTokens: session.inputTokens ?? 0,
    outputTokens: session.outputTokens ?? 0,
    contextWindow,
    wasCompacted: session.wasCompacted ?? false,
  };
}

function persistedStatePayload(
  session: PersistedSession,
  featureId: number,
): PersistedStatePayload {
  return {
    blocks: serverBlocksToAgentBlocks(session.blocks),
    lifecycle: persistedSessionToLifecycle(session),
    hasMore: session.hasMore,
    oldestMessageId: session.oldestMessageId,
    maxMessageId: session.maxMessageId,
    maxContentRevision: session.maxContentRevision,
    featureId,
    sessionDbId: session.sessionDbId,
    currentSelection:
      session.runtimeProvider && session.model
        ? { providerId: session.runtimeProvider, modelId: session.model }
        : undefined,
    currentProfile: session.profile ?? undefined,
    permissionMode: parsePermissionMode(session.permissionMode) ?? undefined,
    accessMode: parseAccessMode(session.accessMode),
    runtimeSessionId: session.runtimeSessionId ?? undefined,
    pendingPermission: session.pendingPermission,
    pendingQuestions: session.pendingQuestions,
    contextUsage: persistedContextUsage(session),
    hasFileChanges: session.hasFileChanges,
  };
}

/**
 * What a conversation's saved state hydrates the session store with: the
 * feature's latest session, or `null` when it has none yet.
 */
export function conversationSnapshot(
  response: FeatureAgentStateResponse,
  featureId: number,
): PersistedStatePayload | null {
  const lastSession = response.sessions.at(-1);
  return lastSession ? persistedStatePayload(lastSession, featureId) : null;
}
