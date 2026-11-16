/** Backend-confirmed outcomes of a manual compaction (`session.compact`). */
import { COMPACTION_STOPPED_INTERRUPTION } from "@/lib/agent-message-origin";
import { blocksPatchWithDerived } from "./ws-message-processing";
import type { StoreAccessors } from "./ws-envelope-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";

export function handleCompactStarted(ctx: StoreAccessors, sessionId: string): void {
  if (!ctx.getSession(sessionId).compactRequestPending) return;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      compactRequestPending: false,
      pendingManualCompact: true,
    }),
  );
}

export function handleCompactOk(ctx: StoreAccessors, sessionId: string): void {
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      lifecycle: transitionTurn(ctx.getSession(sessionId).lifecycle, {
        type: "turn_ended",
        reason: "completed",
      }),
      compactRequestPending: false,
      pendingManualCompact: false,
    }),
  );
}

/**
 * A Stop cancelled the compaction before it began. That is the outcome the
 * user asked for, so it ends as a neutral "compaction stopped" marker (the
 * backend persisted the same one), never as a rejected compaction.
 */
export function handleCompactStopped(ctx: StoreAccessors, sessionId: string): void {
  const session = ctx.getSession(sessionId);
  const blocks = [
    ...session.blocks,
    {
      id: `compact-stopped-${Date.now()}`,
      type: "turn_interrupted" as const,
      content: COMPACTION_STOPPED_INTERRUPTION,
    },
  ];
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      ...blocksPatchWithDerived(session.streamingState, blocks),
      compactRequestPending: false,
      pendingManualCompact: false,
    }),
  );
}
