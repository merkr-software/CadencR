import type { AgentBlockData } from "@/components/AgentBlock";
import { blockMessageDbId } from "./ws-message-identity";

/** null marks an already-ambiguous row identity. */
export type DatabaseIdentityOwners = Map<number, string | null>;

export function buildDatabaseIdentityOwners(
  blocks: AgentBlockData[],
  queued: Array<{ action: string; block: AgentBlockData }>,
): DatabaseIdentityOwners {
  const owners: DatabaseIdentityOwners = new Map();
  const visited = new Set<AgentBlockData>();
  const record = (block: AgentBlockData): void => {
    if (visited.has(block)) return;
    visited.add(block);
    const id = blockMessageDbId(block);
    if (id !== null) {
      owners.set(id, !owners.has(id) || owners.get(id) === block.id ? block.id : null);
    }
    block.childBlocks?.forEach(record);
  };
  blocks.forEach(record);
  // Reserve identities already carried by queued replacements, including one
  // that follows the first identify mutation in this batch.
  for (const mutation of queued) {
    if (mutation.action === "replace_parent" || mutation.action === "replace_block")
      record(mutation.block);
  }
  return owners;
}

export function mergeDuplicateAppend(
  existing: AgentBlockData,
  incoming: AgentBlockData,
): AgentBlockData {
  const preferExistingContent = existing.content.length >= incoming.content.length;
  const incomingHasChildren = (incoming.childBlocks?.length ?? 0) > 0;
  if (preferExistingContent && !incomingHasChildren && !incoming.toolArgs) return existing;
  return {
    ...(preferExistingContent ? { ...incoming, ...existing } : { ...existing, ...incoming }),
    content: preferExistingContent ? existing.content : incoming.content,
    childBlocks: incomingHasChildren
      ? incoming.childBlocks
      : (existing.childBlocks ?? incoming.childBlocks),
    toolArgs: preferExistingContent
      ? (existing.toolArgs ?? incoming.toolArgs)
      : (incoming.toolArgs ?? existing.toolArgs),
  };
}
