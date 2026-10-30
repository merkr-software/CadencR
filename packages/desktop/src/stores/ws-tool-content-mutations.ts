import type { AgentBlockData } from "@/components/AgentBlock";
import type { BlockMutation, StreamingState } from "./ws-message-processing";
import {
  latestValidJsonSnapshot,
  mergeCompletedToolSnapshot,
  mergeToolContent,
} from "./ws-tool-content";
import {
  createStructuredToolStream,
  pendingStructuredToolContent,
  pushStructuredToolChunk,
} from "./ws-structured-tool-stream";

export function applyBlockContentMutation(
  state: StreamingState,
  block: AgentBlockData,
  mutation: BlockMutation,
): boolean {
  if (block.type !== "tool_call") {
    if (mutation.action === "finalize") return false;
    // Live content no longer matches the size hydration reported for it.
    block.fullContentBytes = undefined;
    const previous = publishedFields(block);
    const merged = mergeToolContent(block, mutation.block.content, mutation.action);
    block.content = merged.text;
    if (merged.truncated) block.truncatedContent = true;
    return publishedFieldsChanged(previous, block);
  }
  return applyToolContentMutation(state, block, mutation);
}

function applyToolContentMutation(
  state: StreamingState,
  block: AgentBlockData,
  mutation: BlockMutation,
): boolean {
  const previous = publishedFields(block);
  block.fullContentBytes = undefined;
  if (mutation.action === "replace") {
    state.structuredToolStreams.delete(block.id);
    const merged = mergeToolContent(block, mutation.block.content, "replace");
    applyPublishedContent(state, block, merged.text, merged.truncated);
    return publishedFieldsChanged(previous, block);
  }
  if (mutation.action === "finalize") {
    return finalizeStream(state, block);
  }

  const existingStream = state.structuredToolStreams.get(block.id);
  const stream = existingStream ?? createStructuredToolStream();
  if (!existingStream && block.content) {
    // Reconnect snapshots can seed a block with an incomplete prefix. Scan it
    // once so future chunks resume at the true structured boundary.
    const seeded = pushStructuredToolChunk(stream, block.content);
    if (!block.toolArgs) {
      for (const completed of seeded.completed) publishSnapshot(state, block, completed);
    }
  }
  state.structuredToolStreams.set(block.id, stream);
  const pushed = pushStructuredToolChunk(stream, mutation.block.content);
  block.content = pushed.preview.text;
  if (pushed.preview.truncated) block.truncatedContent = true;
  for (const completed of pushed.completed) publishSnapshot(state, block, completed);
  if (pushed.completed.length > 0) {
    stream.preview = { text: block.content, truncated: block.truncatedContent === true };
  }
  stream.owner = block;
  return publishedFieldsChanged(previous, block);
}

function finalizeStream(state: StreamingState, block: AgentBlockData): boolean {
  const stream = state.structuredToolStreams.get(block.id);
  if (!stream) return false;
  const previous = publishedFields(block);
  const pending = pendingStructuredToolContent(stream);
  if (pending) publishSnapshot(state, block, pending);
  state.structuredToolStreams.delete(block.id);
  return publishedFieldsChanged(previous, block);
}

function publishSnapshot(state: StreamingState, block: AgentBlockData, snapshot: string): void {
  const merged = mergeCompletedToolSnapshot(block, snapshot);
  if (!merged) return;
  block.content = merged.text;
  block.toolArgs = merged.text;
  if (merged.truncated) block.truncatedContent = true;
  syncCanonicalToolBlock(state, block);
}

function applyPublishedContent(
  state: StreamingState,
  block: AgentBlockData,
  content: string,
  truncated: boolean,
): void {
  block.content = content;
  if (truncated) block.truncatedContent = true;
  const latest = latestValidJsonSnapshot(content);
  if (latest) block.toolArgs = latest;
  syncCanonicalToolBlock(state, block);
}

function syncCanonicalToolBlock(state: StreamingState, block: AgentBlockData): void {
  if (!block.toolUseId) return;
  const canonical = state.toolUseIdToBlock.get(block.toolUseId);
  if (canonical && canonical !== block) {
    canonical.toolArgs = block.toolArgs;
    canonical.content = block.content;
    canonical.truncatedContent = block.truncatedContent;
    canonical.fullContentBytes = block.fullContentBytes;
  }
}

function publishedFields(block: AgentBlockData): [string, string | undefined, boolean | undefined] {
  return [block.content, block.toolArgs, block.truncatedContent];
}

function publishedFieldsChanged(
  previous: [string, string | undefined, boolean | undefined],
  block: AgentBlockData,
): boolean {
  return (
    previous[0] !== block.content ||
    previous[1] !== block.toolArgs ||
    previous[2] !== block.truncatedContent
  );
}
