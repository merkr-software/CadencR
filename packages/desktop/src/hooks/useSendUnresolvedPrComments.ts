import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { CommentThread, PrSummary } from "@/api/generated";
import type { AgentPathMapper } from "@/lib/git-paths";
import { formatPrThreadsForAgent } from "@/lib/pr-review-threads";

export interface UseSendUnresolvedPrCommentsParams {
  unresolved: readonly CommentThread[];
  pr: PrSummary | null | undefined;
  /**
   * Names the threads' files for the agent (`useAgentPathMapper`); sending
   * waits while it is `undefined`.
   */
  toAgentPath: AgentPathMapper | undefined;
  /** Dispatches the formatted briefing to the feature's agent. */
  onSend?: (message: string) => void;
}

export interface UseSendUnresolvedPrCommentsResult {
  send: (selected?: readonly CommentThread[]) => void;
  disabled: boolean;
  /** Callers should render the button iff this is true. */
  shouldRender: boolean;
}

/**
 * Hands the forge's open review feedback to the agent.
 *
 * Unlike local drafts, nothing is consumed by sending: resolution lives on the
 * forge, so the button stays available and the same threads can be re-sent
 * after a failed attempt. Cadencr never marks a thread resolved on the
 * developer's behalf — that is a statement only a human should make on a review.
 */
export function useSendUnresolvedPrComments(
  params: UseSendUnresolvedPrCommentsParams,
): UseSendUnresolvedPrCommentsResult {
  const { unresolved, pr, toAgentPath, onSend } = params;
  const count = unresolved.length;
  const shouldRender = !!onSend && count > 0;
  const disabled = !onSend || !toAgentPath || count === 0;

  const send = useCallback(
    (selected?: readonly CommentThread[]): void => {
      const threads = selected ?? unresolved;
      if (!onSend || !toAgentPath || threads.length === 0) return;
      const message = formatPrThreadsForAgent(threads, pr, toAgentPath);
      if (!message) {
        toast.error("Those review threads could not be formatted for the agent.");
        return;
      }
      onSend(message);
      toast.success(
        `Sent ${threads.length} review ${threads.length === 1 ? "thread" : "threads"} to the agent.`,
      );
    },
    [onSend, pr, toAgentPath, unresolved],
  );

  return useMemo(() => ({ send, disabled, shouldRender }), [disabled, send, shouldRender]);
}
