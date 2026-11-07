/**
 * Pure functions for processing WebSocket SDK messages into block mutations.
 *
 * These are stateless transforms — they read/write a StreamingState struct
 * but never touch Zustand or the DOM.
 */

export { createStreamingState, isRecord, processSdkMessage } from "./ws-message-processing-core";
export type {
  BlockMutation,
  MessageProcessingResult,
  ParserSignals,
  StreamingState,
} from "./ws-message-processing-core";

// Re-export block mutation helpers for existing consumers
export {
  applyMutations,
  blocksPatchWithDerived,
  buildMessagePatch,
  parseTodosFromBlocks,
  rebuildDerivedAgentStreamState,
} from "./ws-block-mutations";
export type { MessagePatch, ParsedTodo } from "./ws-block-mutations";
