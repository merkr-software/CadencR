import { useCallback, useMemo } from "react";
import {
  appendComposerContext,
  composerKeyFor,
  useComposerContextItems,
  useComposerContextStore,
} from "@/stores/composer-context-store";
import type { SendFn } from "../agent-prompt-send";
import { settleSentReviewComments } from "./review-comments";
import { useSideQuestionRoute } from "./useSideQuestionRoute";

/**
 * Wraps a send function so the composer's context tray rides along: its items
 * are appended to the prompt text, and removed only once the send succeeded
 * (a failed send keeps them, like it keeps the draft). Only the items sent are
 * removed: one added while the send was in flight waits for the next message.
 *
 * A `/cadencr:side` prompt is routed to a side conversation first, and keeps
 * the tray for the agent's own next prompt. `decorate` rewrites the typed text
 * first (the skill wizard's flags after the command); the draft, history and a
 * failed send's restore all keep the text as typed.
 */
export function useContextualSend(
  featureId: number | undefined,
  sessionId: number | undefined,
  decorate: (text: string) => string,
) {
  const key = composerKeyFor(featureId);
  const items = useComposerContextItems(key);
  const routeSideQuestion = useSideQuestionRoute(sessionId);
  const withContext = useCallback(
    (send: SendFn): SendFn =>
      routeSideQuestion(async (text, attachments) => {
        const snapshot = useComposerContextStore.getState().items[key] ?? [];
        await send(appendComposerContext(decorate(text), snapshot), attachments);
        useComposerContextStore.getState().remove(key, ...snapshot.map((item) => item.id));
        void settleSentReviewComments(featureId, snapshot);
      }),
    [decorate, featureId, key, routeSideQuestion],
  );
  const contextItemCount = items.length;
  return useMemo(() => ({ contextItemCount, withContext }), [contextItemCount, withContext]);
}
