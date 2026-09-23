/**
 * `session.message` envelope handling — the streaming hot path.
 *
 * Split out from `ws-envelope-session-handlers.ts` so the coalescer can import
 * `handleMessageBatch` without pulling the whole session-handler surface, and to
 * keep each file within the size budget.
 */

import { applyBlockContentBudget } from "@/lib/block-content-budget";
import { parseMessageBlocksPayload } from "./ws-envelope-payload";
import { appendErrorBlockPatch } from "./ws-session-store-helpers";
import {
  type BlockMutation,
  type StreamingState,
  isRecord,
  processSdkMessage,
  applyMutations,
  buildMessagePatch,
} from "./ws-message-processing";
import { trackStreamSeq } from "./ws-session-resync";
import { hasOpenGate } from "./ws-gate-state";
import { pendingPromptTailStartIndex } from "./ws-pending-prompts";
import type { SessionEntry } from "./ws-session-types";
import { updateSession } from "./ws-session-types";
import { transitionTurn } from "./ws-turn-lifecycle";
import type { StoreAccessors } from "./ws-envelope-types";

export function handleMessage(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  handleMessageBatch(ctx, sessionId, [payload]);
}

/**
 * Apply a burst of coalesced `session.message` payloads in a single store
 * commit. The delta coalescer (see `ws-delta-coalescer.ts`) buffers deltas per
 * animation frame and hands the batch here so a fast token stream produces one
 * React commit instead of one per envelope.
 *
 * Equivalent to processing a single envelope whose blocks are the concatenation
 * of every payload's blocks: `processMessageBlocks` already runs every block's
 * `processSdkMessage` before the single `applyMutations`, so cross-envelope
 * ordering is preserved. Seq is tracked per payload (in arrival order) so gap
 * detection is unchanged. A malformed payload in the middle flushes the valid
 * blocks accumulated before it, then surfaces its error inline, so the error
 * block lands at the malformed point rather than jumping ahead of earlier valid
 * deltas. The all-valid common case still commits exactly once.
 */
export function handleMessageBatch(
  ctx: StoreAccessors,
  sessionId: string,
  payloads: unknown[],
): void {
  const state = ctx.getSession(sessionId).streamingState;
  let pendingBlocks: unknown[] = [];
  for (const payload of payloads) {
    const p = parseMessageBlocksPayload(payload);
    if (!p) {
      // Apply the valid prefix first so the malformed-error block is appended
      // after the deltas that preceded it, not before them. Empty prefixes are
      // a no-op (processMessageBlocks early-returns), so back-to-back malformed
      // payloads don't emit spurious commits.
      processMessageBlocks(ctx, sessionId, state, pendingBlocks);
      pendingBlocks = [];
      surfaceMalformedMessage(ctx, sessionId, payload);
      continue;
    }
    trackStreamSeq(ctx, sessionId, state, p.seq);
    for (const block of p.blocks) pendingBlocks.push(block);
  }
  processMessageBlocks(ctx, sessionId, state, pendingBlocks);
}

/**
 * Never drop silently: a malformed `session.message` is a lost stream chunk —
 * the exact "text stopped mid-message" a user can't diagnose. Surface it inline
 * so the truncation is visible (error-handling.md).
 */
function surfaceMalformedMessage(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  console.warn("[ws-session] dropping malformed session.message payload", payload);
  const session = ctx.getSession(sessionId);
  ctx.set(
    updateSession(
      ctx.get(),
      sessionId,
      appendErrorBlockPatch(
        session,
        "A streamed update from the agent was malformed and could not be displayed. The transcript above may be incomplete.",
        { code: "MALFORMED_MESSAGE" },
      ),
    ),
  );
}

function processMessageBlocks(
  ctx: StoreAccessors,
  sessionId: string,
  state: StreamingState,
  blocks: unknown[],
): void {
  const allMutations: BlockMutation[] = [];
  let enterPlanModeRequested = false;
  let compactBoundaryObserved = false;
  let manualCompactBoundaryObserved = false;
  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock)) continue;
    const result = processSdkMessage(rawBlock, state);
    // Every streamed block reaches the store through here, so this is the only
    // place that can bound an *append* — `applyMutations` inserts those blocks
    // verbatim, and `mergeToolContent` only caps the accumulation on updates.
    // A block that arrives whole (a large tool_result) would otherwise be
    // retained at full size for the session.
    for (const mutation of result.mutations) {
      // Raw tool deltas are transient scanner input, not store content. A
      // middle-of-string chunk can exceed the budget without starting like
      // JSON; clamping it here would splice a notice into the provider value
      // before the incremental scanner can reconstruct the envelope.
      const budgeted =
        mutation.action === "update" && mutation.block.type === "tool_call"
          ? mutation.block
          : applyBlockContentBudget(mutation.block);
      allMutations.push(budgeted === mutation.block ? mutation : { ...mutation, block: budgeted });
    }
    enterPlanModeRequested ||= result.signals.enterPlanModeRequested;
    compactBoundaryObserved ||= result.signals.compactBoundaryObserved;
    // Older persisted/runtime boundaries may not include metadata. Treat that
    // shape as manual so an in-flight explicit `/compact` can complete.
    manualCompactBoundaryObserved ||=
      result.signals.compactBoundaryObserved && result.signals.compactBoundaryTrigger !== "auto";
  }

  if (allMutations.length === 0 && !compactBoundaryObserved) return;

  const currentSession = ctx.getSession(sessionId);
  const patch: Partial<SessionEntry> = {};
  if (allMutations.length > 0) {
    const rootVersionBefore = state.rootBlocksVersion;
    const toolResultVersionBefore = state.toolResultMapVersion;
    const newBlocks = applyMutations(
      currentSession.blocks,
      allMutations,
      state,
      pendingPromptTailStartIndex(currentSession.blocks),
    );
    const messagePatch = buildMessagePatch(newBlocks, allMutations, { enterPlanModeRequested });
    if (newBlocks !== currentSession.blocks) patch.blocks = newBlocks;
    if (messagePatch.hasFileChanges !== undefined) {
      patch.hasFileChanges = messagePatch.hasFileChanges;
    }
    if (messagePatch.todos !== undefined) patch.todos = messagePatch.todos;
    if (messagePatch.permissionMode !== undefined)
      patch.permissionMode = messagePatch.permissionMode;
    // applyMutations maintains derived state incrementally (reindexing only the
    // pending suffix for a root append); snapshot fresh refs only for the
    // structures it actually touched.
    // A pure text/tool-call delta never appends a tool_result, so the O(M)
    // toolResultMap clone is skipped — its ref stays stable and tool blocks
    // don't needlessly re-render.
    if (state.rootBlocksVersion !== rootVersionBefore) {
      patch.rootBlocks = state.rootBlocks.slice();
    }
    if (state.toolResultMapVersion !== toolResultVersionBefore) {
      patch.toolResultMap = new Map(state.toolResultMap);
    }
  }

  if (compactBoundaryObserved) {
    const existing = currentSession.contextUsage;
    patch.contextUsage = existing
      ? { ...existing, wasCompacted: true }
      : {
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: null,
          wasCompacted: true,
        };
  }

  // Streamed chunks arrive while a user gate is open (background subagents,
  // trailing results of parallel tool calls). They must not flip the paused
  // lifecycle back to active, or the whole gate wait is booked as agent time
  // in the turn summary. An in-flight answer only ends the wait when it
  // covers the last open gate — with more gates queued behind it the user
  // is still being waited on.
  const submittingLastGate =
    currentSession.submittingPermissionRequestId != null &&
    currentSession.pendingPermissionQueue.length === 0 &&
    currentSession.pendingQuestions.length === 0 &&
    currentSession.pendingPlanApproval == null;
  const awaitingUserGate = hasOpenGate(currentSession) && !submittingLastGate;
  const lifecycle =
    manualCompactBoundaryObserved && currentSession.pendingManualCompact
      ? transitionTurn(currentSession.lifecycle, {
          type: "turn_ended",
          reason: "completed",
        })
      : awaitingUserGate
        ? currentSession.lifecycle
        : transitionTurn(currentSession.lifecycle, { type: "stream_activity" });
  if (lifecycle !== currentSession.lifecycle) patch.lifecycle = lifecycle;
  if (manualCompactBoundaryObserved && currentSession.pendingManualCompact) {
    patch.pendingManualCompact = false;
  }

  if (Object.keys(patch).length === 0) return;
  ctx.set(updateSession(ctx.get(), sessionId, patch));
}
