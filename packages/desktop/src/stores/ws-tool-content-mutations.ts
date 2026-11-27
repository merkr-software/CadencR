import { bashPreviewMayOmitMetadata, type AgentBlockData } from "@/types/agent-block";
import type { ClampedText } from "@/lib/block-content-budget";
import type { BlockMutation, StreamingState } from "./ws-message-processing";
import { blockMessageDbId, messageDbId } from "./ws-message-identity";
import type { DatabaseIdentityOwners } from "./ws-block-reconciliation";
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
  databaseOwners?: DatabaseIdentityOwners,
): boolean {
  if (mutation.action === "identify") {
    const id = messageDbId(mutation.block.messageDbId);
    if (
      id === undefined ||
      blockMessageDbId(block) !== null ||
      block.type !== mutation.block.type ||
      !databaseOwners ||
      (databaseOwners.has(id) && databaseOwners.get(id) !== block.id)
    )
      return false;
    block.messageDbId = id;
    databaseOwners.set(id, block.id);
    state.unidentifiedContentIds.delete(block.id);
    return true;
  }
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
    applyPublishedContent(state, block, merged);
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
  if (block.toolName === "Bash" && merged.truncated && !merged.bashOutputOnly) {
    block[bashPreviewMayOmitMetadata] = true;
  }
  syncCanonicalToolBlock(state, block);
}

function applyPublishedContent(
  state: StreamingState,
  block: AgentBlockData,
  { text, truncated, bashOutputOnly }: ClampedText,
): void {
  block.content = text;
  if (truncated) block.truncatedContent = true;
  const latest = latestValidJsonSnapshot(text, truncated);
  if (latest) {
    block.toolArgs = latest;
    if (block.toolName === "Bash") {
      block[bashPreviewMayOmitMetadata] = truncated && !bashOutputOnly ? true : undefined;
    }
  }
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
    canonical[bashPreviewMayOmitMetadata] = block[bashPreviewMayOmitMetadata];
  }
}

function publishedFields(block: AgentBlockData) {
  return [
    block.content,
    block.toolArgs,
    block.truncatedContent,
    block[bashPreviewMayOmitMetadata],
  ] as const;
}

function publishedFieldsChanged(
  previous: ReturnType<typeof publishedFields>,
  block: AgentBlockData,
): boolean {
  return (
    previous[0] !== block.content ||
    previous[1] !== block.toolArgs ||
    previous[2] !== block.truncatedContent ||
    previous[3] !== block[bashPreviewMayOmitMetadata]
  );
}
