import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { SendFn } from "../agent-prompt-send";
import { usePromptQueue } from "./usePromptQueue";

interface UseQueueSendArgs {
  sessionId: number | undefined;
  isRunning: boolean;
  /** Draft text has content and the bar accepts input. */
  canSend: boolean;
  isShellCommandMode: boolean;
  attachmentCount: number;
  textRef: { current: string };
  runSend: (send: SendFn, trimmed: string) => Promise<void>;
  /** Appends the context tray to whatever is sent (see `useContextualSend`). */
  withContext: (send: SendFn) => SendFn;
  /** The plain-Enter path (send, or steer while the agent works). */
  handleEnterSend: () => boolean;
}

/**
 * "Queue for after this turn": ⌘/Ctrl+Enter or the send menu while the agent
 * works. Goes through the same send runner as Enter, so the draft clears at
 * once and comes back if the server refuses it. Outside a run ⌘Enter simply
 * sends.
 */
export function useQueueSend({
  sessionId,
  isRunning,
  canSend,
  isShellCommandMode,
  attachmentCount,
  textRef,
  runSend,
  withContext,
  handleEnterSend,
}: UseQueueSendArgs) {
  const queue = usePromptQueue(sessionId);
  const canQueue = isRunning && queue.available && canSend && !isShellCommandMode;

  const handleQueue = useCallback((): void => {
    if (!canQueue) return;
    if (attachmentCount > 0) {
      toast.info("Images can't wait in the queue. Press Enter to send them to the agent now.");
      return;
    }
    void runSend(
      withContext((text) => queue.enqueue(text)),
      textRef.current.trim(),
    );
  }, [attachmentCount, canQueue, queue.enqueue, runSend, textRef, withContext]);

  const handleModEnterSend = useCallback((): boolean => {
    if (!isRunning) return handleEnterSend();
    handleQueue();
    return true;
  }, [handleEnterSend, handleQueue, isRunning]);

  return useMemo(
    () => ({ canQueue, handleQueue, handleModEnterSend }),
    [canQueue, handleModEnterSend, handleQueue],
  );
}
