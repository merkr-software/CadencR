import type { AgentBlockData } from "@/types/agent-block";
import { normalizeToolName } from "@/lib/tool-adapter";
import { createToolUseBlock } from "./ws-message-processing-tool-blocks";
import { processStreamEvent } from "./ws-message-processing-stream";
import { processSystemMessage } from "./ws-message-processing-system";
import { processUserMessage } from "./ws-message-processing-user";
import { nextSyntheticBlockId } from "./ws-message-processing-utils";
import type { StructuredToolStream } from "./ws-structured-tool-stream";
import {
  identifyAssistantContent,
  trackAssistantContentBlocks,
} from "./ws-assistant-content-identity";
import { blockIdFromAgentMessage } from "./ws-message-identity";

export { isRecord } from "./ws-message-processing-utils";

export interface StreamContext {
  model: string | null;
  contentBlockIds: Map<number, string>;
  parentToolUseId: string | null;
}

type StreamSessionId = string | symbol;

const DEFAULT_STREAM_SESSION_ID: StreamSessionId = Symbol("default-stream-session");

export interface StreamingState {
  /** Increments for every parsed runtime message, including a content-free message_start. */
  messageGeneration: number;
  /** Unsaved copies outlive stream cycles until identified or safely resynced. */
  unidentifiedContentIds: Set<string>;
  streams: Map<StreamSessionId, StreamContext>;
  /** Final assistant snapshots retain identities even when nested streams interleave. */
  assistantContentBlocks: Map<
    StreamSessionId,
    Map<string | null, Map<number, { id: string; type: AgentBlockData["type"] }>>
  >;
  toolUseIdToBlock: Map<string, AgentBlockData>;
  counter: number;
  /**
   * Live mirror of the root-level (non-child) blocks. Maintained in sync with
   * the conversation by `applyMutations` so consumers can read the
   * already-filtered list in O(1) instead of scanning the full block array on
   * every streamed chunk.
   */
  rootBlocks: AgentBlockData[];
  /** Index from `block.id` to its position in `rootBlocks`. */
  rootBlockPosById: Map<string, number>;
  /** Map from a tool_call's `toolUseId` to its matching `tool_result` block. */
  toolResultMap: Map<string, AgentBlockData>;
  /**
   * Last `seq` observed on a `session.message` envelope. Used to detect a
   * dropped envelope (gap) so the client can resync instead of silently
   * rendering a truncated message. `null` until the first stamped envelope.
   */
  lastMessageSeq: number | null;
  /**
   * Set when a seq gap was detected mid-turn. The truncated tail can't be
   * repaired while deltas are still flowing (an in-place rewrite would race
   * in-flight appends), so the repair runs once the turn ends.
   */
  tailRepairNeeded: boolean;
  /**
   * Bumped by `applyMutations` whenever it changes anything reachable from a
   * root block (append, root ref replace, or an in-place child update). Lets the
   * caller skip the O(N) `rootBlocks.slice()` snapshot when a delta touched
   * nothing rootward. See `ws-block-mutations.ts`.
   */
  rootBlocksVersion: number;
  /**
   * Bumped whenever a `tool_result` block is recorded into `toolResultMap`.
   * tool_result blocks are only ever appended (never updated in place), so this
   * fully captures every change to the map — letting the caller skip the O(M)
   * `new Map(...)` clone on the common text/tool-call-only delta.
   */
  toolResultMapVersion: number;
  /** Raw chunked input for live tool JSON; kept out of render-facing blocks. */
  structuredToolStreams: Map<string, StructuredToolStream>;
}

export interface ParserSignals {
  enterPlanModeRequested: boolean;
  /** Set when a `system.compact_boundary` message arrives mid-stream. */
  compactBoundaryObserved: boolean;
  compactBoundaryTrigger: string | null;
}

export interface MessageProcessingResult {
  mutations: BlockMutation[];
  signals: ParserSignals;
}

export type BlockMutation = {
  action: "append" | "update" | "replace" | "finalize" | "identify";
  block: AgentBlockData;
};

export function createStreamingState(): StreamingState {
  return {
    messageGeneration: 0,
    unidentifiedContentIds: new Set(),
    streams: new Map(),
    assistantContentBlocks: new Map(),
    toolUseIdToBlock: new Map(),
    counter: 0,
    rootBlocks: [],
    rootBlockPosById: new Map(),
    toolResultMap: new Map(),
    lastMessageSeq: null,
    tailRepairNeeded: false,
    rootBlocksVersion: 0,
    toolResultMapVersion: 0,
    structuredToolStreams: new Map(),
  };
}

function createParserSignals(): ParserSignals {
  return {
    enterPlanModeRequested: false,
    compactBoundaryObserved: false,
    compactBoundaryTrigger: null,
  };
}

export function processSdkMessage(
  msg: Record<string, unknown>,
  state: StreamingState,
): MessageProcessingResult {
  if (!msg || typeof msg !== "object") {
    return { mutations: [], signals: createParserSignals() };
  }

  const signals = createParserSignals();
  state.messageGeneration += 1;

  switch (msg.type as string) {
    case "stream_event": {
      const mutations = processStreamEvent(msg, state);
      trackAssistantContentBlocks(msg, state, mutations);
      return { mutations, signals };
    }
    case "assistant":
      return { mutations: processAssistantMessage(msg, state, signals), signals };
    case "user":
      return { mutations: processUserMessage(msg, state, signals), signals };
    case "system":
      return { mutations: processSystemMessage(msg, state, signals), signals };
    case "result":
      return { mutations: [], signals };
    default:
      // A message type this parser doesn't know. The backend independently
      // surfaces unknown provider messages as visible errors; here we only
      // leave a trace so a "text stopped mid-message" report is diagnosable.
      console.warn("[agent-stream] dropping unknown message type", msg.type);
      return { mutations: [], signals };
  }
}

export { blockIdFromAgentMessage } from "./ws-message-identity";

function processAssistantMessage(
  msg: Record<string, unknown>,
  state: StreamingState,
  signals: ParserSignals,
): BlockMutation[] {
  const assistantMsg = msg.message as Record<string, unknown> | undefined;
  const contentArr = assistantMsg?.content as Array<Record<string, unknown>> | undefined;
  if (!contentArr || !Array.isArray(contentArr)) return [];

  const stream = getOrCreateStreamContext(state, getStreamSessionId(msg));
  const assistantParentId = (msg.parent_tool_use_id as string) ?? null;
  const identities = identifyAssistantContent(msg, contentArr, state);
  const trackedContent = state.assistantContentBlocks
    .get(getStreamSessionId(msg))
    ?.get(assistantParentId);
  const referencesKnownToolUse = contentArr.some(
    (cb) =>
      cb.type === "tool_use" &&
      typeof cb.id === "string" &&
      state.toolUseIdToBlock.has(cb.id as string),
  );

  if (
    (stream.contentBlockIds.size > 0 && assistantParentId === stream.parentToolUseId) ||
    referencesKnownToolUse ||
    trackedContent?.size
  ) {
    return [...identities, ...processAssistantReplace(contentArr, state)];
  }

  const model = (assistantMsg?.model as string | undefined) ?? stream.model ?? undefined;
  const now = new Date().toISOString();
  const results: BlockMutation[] = [];

  for (const contentBlock of contentArr) {
    const mutation = createAssistantMutation(
      contentBlock,
      state,
      signals,
      model,
      assistantParentId,
      now,
    );
    if (mutation) {
      results.push(mutation);
    }
  }
  return results;
}

function processAssistantReplace(
  contentArr: Array<Record<string, unknown>>,
  state: StreamingState,
): BlockMutation[] {
  const results: BlockMutation[] = [];
  for (const contentBlock of contentArr) {
    if (
      contentBlock.type !== "tool_use" ||
      typeof contentBlock.id !== "string" ||
      contentBlock.input === undefined
    ) {
      continue;
    }

    const blockId = state.toolUseIdToBlock.get(contentBlock.id)?.id;
    if (!blockId) continue;

    results.push({
      action: "replace",
      block: {
        id: blockId,
        type: "tool_call",
        content: JSON.stringify(contentBlock.input),
      },
    });
  }
  return results;
}

function createAssistantMutation(
  contentBlock: Record<string, unknown>,
  state: StreamingState,
  signals: ParserSignals,
  model: string | undefined,
  parentToolUseId: string | null,
  createdAt: string,
): BlockMutation | null {
  const blockId = blockIdFromAgentMessage(contentBlock) ?? nextSyntheticBlockId(state);

  switch (contentBlock.type as string) {
    case "text":
      return {
        action: "append",
        block: {
          id: blockId,
          type: "text",
          content: contentBlock.text as string,
          model,
          parentToolUseId,
          createdAt,
        },
      };
    case "thinking":
      return {
        action: "append",
        block: {
          id: blockId,
          type: "thinking",
          content: contentBlock.thinking as string,
          parentToolUseId,
          createdAt,
        },
      };
    case "tool_use":
      if (normalizeToolName(contentBlock.name as string) === "EnterPlanMode") {
        signals.enterPlanModeRequested = true;
      }
      return {
        action: "append",
        block: createToolUseBlock(state, blockId, contentBlock, parentToolUseId, createdAt, true),
      };
    default:
      return null;
  }
}

export function getStreamSessionId(msg: Record<string, unknown>): StreamSessionId {
  return typeof msg.session_id === "string" ? msg.session_id : DEFAULT_STREAM_SESSION_ID;
}

export function getOrCreateStreamContext(
  state: StreamingState,
  streamSessionId: StreamSessionId,
): StreamContext {
  const existing = state.streams.get(streamSessionId);
  if (existing) {
    return existing;
  }

  const created: StreamContext = {
    model: null,
    contentBlockIds: new Map(),
    parentToolUseId: null,
  };
  state.streams.set(streamSessionId, created);
  return created;
}
