import {
  applySubagentRunPush,
  invalidateFeatureSubagents,
  refreshFeatureSubagentsAfterTurn,
} from "@/hooks/useFeatureSubagents";
import type { StoreAccessors } from "./ws-envelope-types";

type SessionActionHandler = (ctx: StoreAccessors, sessionId: string, payload: unknown) => void;

/** `session.subagent_updated`: the backend registry changed one sub-agent. */
export function handleSubagentUpdated(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const featureId = ctx.get().sessions[sessionId]?.featureId;
  if (featureId == null) return;
  if (!applySubagentRunPush(featureId, payload)) {
    console.warn("[ws-session] invalid subagent_updated payload; refetching", payload);
    invalidateFeatureSubagents(featureId);
  }
}

/**
 * A turn's end settles its sub-agents' transcript counts; refetch the list
 * (only where something shows it) after the turn handler ran, when one of
 * them changed.
 */
export function handleTurnEndWithSubagents(handler: SessionActionHandler): SessionActionHandler {
  return (ctx, sessionId, payload) => {
    handler(ctx, sessionId, payload);
    const featureId = ctx.get().sessions[sessionId]?.featureId;
    if (featureId != null) refreshFeatureSubagentsAfterTurn(featureId);
  };
}
