/**
 * `stream_event` processing — content block starts and deltas.
 *
 * This is the hot path for live streaming. Its resilience rule: a chunk the
 * parser can't attach or recognize must never vanish silently — either
 * self-heal (orphan deltas synthesize their block) or leave a console trace,
 * because a silently dropped chunk shows up to the user as text that just
 * stops mid-message.
 *
 * The orphan-delta self-heal here is layer 1 of the four stream-loss recovery
 * layers documented at the top of `ws-session-resync.ts` (the live, in-turn,
 * zero-network one).
 */

import { createToolUseBlock } from "./ws-message-processing-tool-blocks";
import { nextSyntheticBlockId } from "./ws-message-processing-utils";
import {
  blockIdFromAgentMessage,
  getOrCreateStreamContext,
  getStreamSessionId,
  type BlockMutation,
  type StreamContext,
  type StreamingState,
} from "./ws-message-processing-core";

export function processStreamEvent(
  msg: Record<string, unknown>,
  state: StreamingState,
): BlockMutation[] {
  const event = msg.event as Record<string, unknown> | undefined;
  if (!event) return [];

  const stream = getOrCreateStreamContext(state, getStreamSessionId(msg));
  // The server stamps the active model onto every forwarded stream event. Seed
  // `stream.model` from it so a client that missed `message_start` (e.g. a
  // remote device that joined the turn late) still labels streamed text with
  // the right model instead of "unknown".
  if (typeof msg.model === "string") {
    stream.model = msg.model;
  }
  const parentToolUseId = (msg.parent_tool_use_id as string) ?? null;
  // Mark the previous subagent complete when a new message/block context opens
  // under a different parent — a real context switch for a *foreground* subagent
  // (subagent → subagent, or subagent → main-agent resume). A switch begins with
  // either a `message_start` (a new speaker) or a `content_block_start`; both are
  // valid triggers. Two things must NOT trigger it:
  //  - Deltas: a Task's own `input_json_delta` streams at root (parent=null)
  //    while its children already set the context, so keying completion off
  //    deltas marks the Task complete the instant its args finish streaming.
  //    (This is why the trigger is gated to the two "context opens" events and
  //    excludes `content_block_delta`.)
  //  - Background subagents: they interleave with the main agent, so the context
  //    legitimately switches away and back while they keep running. Completing
  //    them here kills the panel the moment the main agent resumes — only
  //    `turn_complete` ends a background subagent.
  if (
    (event.type === "message_start" || event.type === "content_block_start") &&
    stream.parentToolUseId &&
    stream.parentToolUseId !== parentToolUseId
  ) {
    const prevParent = state.toolUseIdToBlock.get(stream.parentToolUseId);
    if (prevParent?.childBlocks && !prevParent.taskBackground) {
      prevParent.taskComplete = true;
    }
  }
  stream.parentToolUseId = parentToolUseId;

  switch (event.type as string) {
    case "message_start": {
      const message = event.message as Record<string, unknown> | undefined;
      if (message?.model) {
        stream.model = message.model as string;
      }
      stream.contentBlockIds.clear();
      return [];
    }
    case "content_block_start":
      return processContentBlockStart(
        event,
        state,
        stream,
        parentToolUseId,
        blockIdFromAgentMessage(msg),
      );
    case "content_block_delta":
      return processContentBlockDelta(
        event,
        state,
        stream,
        parentToolUseId,
        blockIdFromAgentMessage(msg),
      );
    // Envelope markers with no renderable content — intentionally ignored.
    case "content_block_stop":
    case "message_delta":
    case "message_stop":
      return [];
    default:
      console.warn("[agent-stream] dropping unknown stream event type", event.type);
      return [];
  }
}

function processContentBlockStart(
  event: Record<string, unknown>,
  state: StreamingState,
  stream: StreamContext,
  parentToolUseId: string | null,
  persistedBlockId: string | null,
): BlockMutation[] {
  const index = event.index as number;
  const contentBlock = event.content_block as Record<string, unknown> | undefined;
  if (!contentBlock) return [];

  // An unrenderable block type must NOT claim the index: leaving the index
  // unregistered lets the first delta self-heal into a rendered block
  // (processContentBlockDelta), instead of every delta updating a block that
  // was never appended — which applyMutations silently discards.
  if (!isRenderableContentBlockType(contentBlock.type)) {
    console.warn("[agent-stream] unknown content block type at start", contentBlock.type);
    return [];
  }

  const blockId = persistedBlockId ?? nextSyntheticBlockId(state);
  stream.contentBlockIds.set(index, blockId);

  switch (contentBlock.type as string) {
    case "tool_use":
      return [
        {
          action: "append",
          block: createToolUseBlock(
            state,
            blockId,
            contentBlock,
            parentToolUseId,
            new Date().toISOString(),
            false,
          ),
        },
      ];
    case "thinking":
      return [
        {
          action: "append",
          block: {
            id: blockId,
            type: "thinking",
            content: typeof contentBlock.thinking === "string" ? contentBlock.thinking : "",
            parentToolUseId,
            createdAt: new Date().toISOString(),
          },
        },
      ];
    case "text":
      return [
        {
          action: "append",
          block: {
            id: blockId,
            type: "text",
            content: typeof contentBlock.text === "string" ? contentBlock.text : "",
            parentToolUseId,
            model: stream.model ?? undefined,
            createdAt: new Date().toISOString(),
          },
        },
      ];
    default:
      return [];
  }
}

function isRenderableContentBlockType(type: unknown): boolean {
  return type === "tool_use" || type === "thinking" || type === "text";
}

/** Block type and content carried by a known delta type, or null for unknown. */
function deltaPayload(
  delta: Record<string, unknown>,
): { type: "text" | "thinking" | "tool_call"; content: string } | null {
  switch (delta.type as string) {
    case "text_delta":
      return { type: "text", content: (delta.text as string) ?? "" };
    case "thinking_delta":
      return { type: "thinking", content: (delta.thinking as string) ?? "" };
    case "input_json_delta":
      return { type: "tool_call", content: (delta.partial_json as string) ?? "" };
    default:
      return null;
  }
}

function processContentBlockDelta(
  event: Record<string, unknown>,
  state: StreamingState,
  stream: StreamContext,
  parentToolUseId: string | null,
  persistedBlockId: string | null,
): BlockMutation[] {
  const index = event.index as number;
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta) return [];

  const payload = deltaPayload(delta);
  if (!payload) {
    console.warn("[agent-stream] dropping unknown content delta type", delta.type);
    return [];
  }

  const knownBlockId = stream.contentBlockIds.get(index);

  // Self-heal an orphan delta: if the `content_block_start` for this index was
  // never seen (lost envelope, block type we couldn't render at start),
  // dropping the delta would silently discard every following chunk of this
  // block — the text visibly "stops mid-message" while the backend keeps
  // persisting fine. Synthesize the block from the first delta instead, so
  // this and all subsequent deltas render.
  if (!knownBlockId) {
    console.warn(
      "[agent-stream] content_block_delta for unseen block index; synthesizing block",
      index,
    );
    const blockId = persistedBlockId ?? nextSyntheticBlockId(state);
    stream.contentBlockIds.set(index, blockId);
    return [
      {
        action: "append",
        block: {
          id: blockId,
          type: payload.type,
          content: payload.content,
          parentToolUseId,
          model: payload.type === "text" ? (stream.model ?? undefined) : undefined,
          createdAt: new Date().toISOString(),
        },
      },
    ];
  }

  return [
    { action: "update", block: { id: knownBlockId, type: payload.type, content: payload.content } },
  ];
}
