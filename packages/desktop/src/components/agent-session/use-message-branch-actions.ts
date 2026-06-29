import { useCallback, useMemo } from "react";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { messageIdFromBlockId, type AgentBlockData } from "../AgentBlock";
import { useAgentSessionContext } from "./agent-session-context";

export interface MessageBranchActions {
  /** True when this block is a persisted user message inside a live session. */
  canBranch: boolean;
  /** Rewind the session to this message (no-op when `canBranch` is false). */
  rewind: () => void;
  /** Fork a new session from this message (no-op when `canBranch` is false). */
  fork: () => void;
}

/**
 * Resolve rewind/fork affordances for a stream block. Shared by the per-block
 * context menu and the on-hover user-message toolbar so the gating logic lives
 * in exactly one place.
 *
 * A persisted user message encodes its DB id in `id` (`msg-<n>`); a message
 * sent live this session is still a local `ws-user-*` block and relies on the
 * `messageDbId` stamped by the `prompt_persisted` ack. Both store actions are
 * stable refs, so subscribing here adds no streaming re-renders.
 */
export function useMessageBranchActions(block: AgentBlockData): MessageBranchActions {
  const { wsSessionId } = useAgentSessionContext();
  const rewindToMessage = useWsSessionStore((s) => s.rewindToMessage);
  const forkFromMessage = useWsSessionStore((s) => s.forkFromMessage);

  const messageId =
    block.type === "user_message"
      ? (block.messageDbId ?? messageIdFromBlockId(block.id))
      : undefined;
  const canBranch = wsSessionId != null && messageId != null;

  const rewind = useCallback(() => {
    if (wsSessionId != null && messageId != null) rewindToMessage(wsSessionId, messageId);
  }, [wsSessionId, messageId, rewindToMessage]);

  const fork = useCallback(() => {
    if (wsSessionId != null && messageId != null) forkFromMessage(wsSessionId, messageId);
  }, [wsSessionId, messageId, forkFromMessage]);

  // Stable object so downstream memoized consumers (the hover toolbar, the
  // per-block context menu) don't re-render on every parent commit.
  return useMemo(() => ({ canBranch, rewind, fork }), [canBranch, rewind, fork]);
}
