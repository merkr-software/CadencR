import type { AgentBlockData } from "@/components/AgentBlock";
import type { SessionEntry } from "./ws-session-types";
import { blockMessageDbId } from "./ws-message-identity";

export interface PersistenceRepairPlan {
  ids: Set<string>;
  cursor: number;
  sessionDbId: number | null;
  lifecycle: SessionEntry["lifecycle"];
  health: SessionEntry["persistenceStatus"];
  generation: number;
  rootVersion: number;
}

/** Recovery must be confirmed before the snapshot request begins. */
export function capturePersistenceRepair(session: SessionEntry): PersistenceRepairPlan | null {
  if (
    session.persistenceStatus?.status !== "recovered" ||
    session.lifecycle.phase === "active" ||
    session.lifecycle.phase === "paused"
  )
    return null;
  const tracked = session.streamingState.unidentifiedContentIds;
  if (tracked.size === 0) return null;
  const ids = new Set<string>();
  let cursor = Number.POSITIVE_INFINITY;
  let precedingId = 0;
  const visit = (block: AgentBlockData): void => {
    const id = blockMessageDbId(block);
    if (
      id === null &&
      tracked.has(block.id) &&
      (block.type === "text" || block.type === "thinking")
    ) {
      ids.add(block.id);
      cursor = Math.min(cursor, precedingId);
    }
    block.childBlocks?.forEach(visit);
  };
  // A prompt is persisted before its output. Nested children can arrive later
  // than following root rows, so their row IDs are not safe lower anchors.
  session.blocks.forEach((block) => {
    const id = blockMessageDbId(block);
    if (block.type === "user_message" && id !== null) precedingId = id;
    visit(block);
  });
  if (ids.size === 0) return null;
  return {
    ids,
    cursor,
    sessionDbId: session.sessionDbId,
    lifecycle: session.lifecycle,
    health: session.persistenceStatus,
    generation: session.streamingState.messageGeneration,
    rootVersion: session.streamingState.rootBlocksVersion,
  };
}

/** Remove only the captured unsaved copies after a complete, race-free canonical tail. */
export function removeRepairedSyntheticTail(
  session: SessionEntry,
  plan: PersistenceRepairPlan | null,
  canonical: AgentBlockData[],
  complete: boolean,
): AgentBlockData[] {
  if (
    !plan ||
    !complete ||
    session.sessionDbId !== plan.sessionDbId ||
    session.lifecycle !== plan.lifecycle ||
    session.persistenceStatus !== plan.health ||
    session.streamingState.messageGeneration !== plan.generation ||
    session.streamingState.rootBlocksVersion !== plan.rootVersion
  )
    return session.blocks;
  let coveredRows = 0;
  const count = (block: AgentBlockData): void => {
    const id = blockMessageDbId(block);
    if (id !== null && id > plan.cursor && (block.type === "text" || block.type === "thinking"))
      coveredRows += 1;
    block.childBlocks?.forEach(count);
  };
  canonical.forEach(count);
  if (coveredRows < plan.ids.size) return session.blocks;
  const filter = (blocks: AgentBlockData[]): AgentBlockData[] => {
    let changed = false;
    const result = blocks.flatMap((block): AgentBlockData[] => {
      if (plan.ids.has(block.id) && blockMessageDbId(block) === null) {
        changed = true;
        return [];
      }
      const children = block.childBlocks ? filter(block.childBlocks) : undefined;
      if (children !== block.childBlocks) {
        changed = true;
        return [{ ...block, childBlocks: children }];
      }
      return [block];
    });
    return changed ? result : blocks;
  };
  const repaired = filter(session.blocks);
  if (repaired !== session.blocks) {
    for (const id of plan.ids) session.streamingState.unidentifiedContentIds.delete(id);
  }
  return repaired;
}
