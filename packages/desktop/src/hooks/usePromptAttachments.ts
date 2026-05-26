import { useMemo } from "react";
import { useImageAttachments, type UseImageAttachmentsResult } from "@/hooks/useImageAttachments";
import { promptDropTargetIdOf } from "@/lib/prompt-drop-target";

export interface PromptAttachmentsArgs {
  wsSessionId?: string | null;
  sessionId?: number | null;
  featureId?: number | null;
}

export interface UsePromptAttachmentsResult extends UseImageAttachmentsResult {
  /**
   * Stable id the agent `<section>` stamps via `data-agent-prompt-id`. The
   * preload's drop handler reads it back so the OS drop is routed to the
   * matching `useImageAttachments` consumer.
   */
  promptDropTargetId: string;
}

/**
 * Wires up image attachments for a prompt bar — derives the drop-routing id
 * from the session/feature identity and forwards the rest of the
 * `useImageAttachments` API. Lives in its own hook so the (already-large)
 * `AgentPromptBar` component doesn't need to know about drop-target wiring.
 */
export function usePromptAttachments(args: PromptAttachmentsArgs): UsePromptAttachmentsResult {
  const promptDropTargetId = useMemo(
    () =>
      promptDropTargetIdOf({
        wsSessionId: args.wsSessionId,
        dbSessionId: args.sessionId,
        featureId: args.featureId,
      }),
    [args.wsSessionId, args.sessionId, args.featureId],
  );
  const attachments = useImageAttachments(promptDropTargetId);
  return useMemo(() => ({ ...attachments, promptDropTargetId }), [attachments, promptDropTargetId]);
}
