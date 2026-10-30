import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import {
  blockSearchableText,
  countConversationOccurrences,
  normalizeConversationQuery,
  type ConversationMatch,
} from "./matches";

interface CachedBlockSearch {
  type: AgentBlockData["type"];
  content: string;
  toolName: string | undefined;
  toolArgs: string | undefined;
  toolUseId: string | undefined;
  resultContent: string | undefined;
  lowerText: string;
  needle: string;
  count: number;
}

export interface ConversationMatchIdentity {
  block: AgentBlockData;
  blockId: string;
  rowKey: string;
  blockIndexInRow: number;
  occurrenceInBlock: number;
}

export interface ConversationSearchIndexOptions {
  /** Test/benchmark probe: called only when a block's occurrence count is rescanned. */
  onBlockScan?: (block: AgentBlockData) => void;
}

/**
 * Immutable, compact result snapshot. Parallel arrays retain one entry per
 * matching block rather than materializing one object per query occurrence.
 */
export class ConversationSearchSnapshot {
  static readonly empty = new ConversationSearchSnapshot([], [], [], [], [], 0);

  readonly matchCount: number;

  constructor(
    private readonly blocks: readonly AgentBlockData[],
    private readonly rowIndices: readonly number[],
    private readonly rowKeys: readonly string[],
    private readonly blockIndicesInRow: readonly number[],
    private readonly prefixEnds: readonly number[],
    matchCount: number,
  ) {
    this.matchCount = matchCount;
  }

  matchAt(ordinal: number): ConversationMatch | null {
    const blockIndex = this.blockIndexAt(ordinal);
    if (blockIndex === -1) return null;
    const previousEnd = blockIndex === 0 ? 0 : this.prefixEnds[blockIndex - 1];
    const block = this.blocks[blockIndex];
    return {
      blockId: block.id,
      rowIndex: this.rowIndices[blockIndex],
      occurrenceInBlock: ordinal - previousEnd,
    };
  }

  identityAt(ordinal: number): ConversationMatchIdentity | null {
    const blockIndex = this.blockIndexAt(ordinal);
    if (blockIndex === -1) return null;
    const previousEnd = blockIndex === 0 ? 0 : this.prefixEnds[blockIndex - 1];
    const block = this.blocks[blockIndex];
    return {
      block,
      blockId: block.id,
      rowKey: this.rowKeys[blockIndex],
      blockIndexInRow: this.blockIndicesInRow[blockIndex],
      occurrenceInBlock: ordinal - previousEnd,
    };
  }

  ordinalOf(identity: ConversationMatchIdentity): number | null {
    const exact = this.findIdentityIndex(identity, true);
    const blockIndex = exact === -1 ? this.findIdentityIndex(identity, false) : exact;
    if (blockIndex === -1) return null;
    const previousEnd = blockIndex === 0 ? 0 : this.prefixEnds[blockIndex - 1];
    const count = this.prefixEnds[blockIndex] - previousEnd;
    if (identity.occurrenceInBlock >= count) return null;
    return previousEnd + identity.occurrenceInBlock;
  }

  private blockIndexAt(ordinal: number): number {
    if (ordinal < 0 || ordinal >= this.matchCount) return -1;
    let low = 0;
    let high = this.prefixEnds.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordinal < this.prefixEnds[middle]) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  private findIdentityIndex(identity: ConversationMatchIdentity, exact: boolean): number {
    for (let index = 0; index < this.blocks.length; index += 1) {
      const block = this.blocks[index];
      if (exact) {
        if (block === identity.block) return index;
        continue;
      }
      if (
        block.id === identity.blockId &&
        this.rowKeys[index] === identity.rowKey &&
        this.blockIndicesInRow[index] === identity.blockIndexInRow
      ) {
        return index;
      }
    }
    return -1;
  }
}

/**
 * Per-conversation incremental matcher. Display rows may be rebuilt on every
 * streamed chunk; block text and counts are rescanned only when their actual
 * searchable inputs (or the active normalized query) change.
 */
export class ConversationSearchIndex {
  private cache = new WeakMap<AgentBlockData, CachedBlockSearch>();
  private readonly onBlockScan: ((block: AgentBlockData) => void) | undefined;

  constructor(options: ConversationSearchIndexOptions = {}) {
    this.onBlockScan = options.onBlockScan;
  }

  clear(): void {
    this.cache = new WeakMap();
  }

  update(
    items: readonly DisplayItem[],
    query: string,
    toolResultMap?: ReadonlyMap<string, AgentBlockData>,
  ): ConversationSearchSnapshot {
    const needle = normalizeConversationQuery(query);
    if (!needle) return ConversationSearchSnapshot.empty;

    const blocks: AgentBlockData[] = [];
    const rowIndices: number[] = [];
    const rowKeys: string[] = [];
    const blockIndicesInRow: number[] = [];
    const prefixEnds: number[] = [];
    let matchCount = 0;

    for (let rowIndex = 0; rowIndex < items.length; rowIndex += 1) {
      const item = items[rowIndex];
      const rowBlockCount = item.kind === "flow" ? item.blocks.length : 1;
      for (let blockIndexInRow = 0; blockIndexInRow < rowBlockCount; blockIndexInRow += 1) {
        const block = item.kind === "flow" ? item.blocks[blockIndexInRow] : item.block;
        const count = this.countFor(block, needle, toolResultMap);
        if (count === 0) continue;
        matchCount += count;
        blocks.push(block);
        rowIndices.push(rowIndex);
        rowKeys.push(item.key);
        blockIndicesInRow.push(blockIndexInRow);
        prefixEnds.push(matchCount);
      }
    }

    return new ConversationSearchSnapshot(
      blocks,
      rowIndices,
      rowKeys,
      blockIndicesInRow,
      prefixEnds,
      matchCount,
    );
  }

  private countFor(
    block: AgentBlockData,
    needle: string,
    toolResultMap?: ReadonlyMap<string, AgentBlockData>,
  ): number {
    const result = pairedBashResult(block, toolResultMap);
    let cached = this.cache.get(block);
    if (!cached || searchableInputsChanged(cached, block, result)) {
      cached = createCachedBlock(block, result, toolResultMap);
      this.cache.set(block, cached);
    }
    if (cached.needle !== needle) {
      cached.needle = needle;
      cached.count = countConversationOccurrences(cached.lowerText, needle);
      this.onBlockScan?.(block);
    }
    return cached.count;
  }
}

function pairedBashResult(
  block: AgentBlockData,
  toolResultMap?: ReadonlyMap<string, AgentBlockData>,
): AgentBlockData | undefined {
  if (block.type !== "tool_call" || block.toolName !== "Bash" || !block.toolUseId) {
    return undefined;
  }
  return toolResultMap?.get(block.toolUseId);
}

function searchableInputsChanged(
  cached: CachedBlockSearch,
  block: AgentBlockData,
  result: AgentBlockData | undefined,
): boolean {
  return (
    cached.type !== block.type ||
    cached.content !== block.content ||
    cached.toolName !== block.toolName ||
    cached.toolArgs !== block.toolArgs ||
    cached.toolUseId !== block.toolUseId ||
    cached.resultContent !== result?.content
  );
}

function createCachedBlock(
  block: AgentBlockData,
  result: AgentBlockData | undefined,
  toolResultMap?: ReadonlyMap<string, AgentBlockData>,
): CachedBlockSearch {
  return {
    type: block.type,
    content: block.content,
    toolName: block.toolName,
    toolArgs: block.toolArgs,
    toolUseId: block.toolUseId,
    resultContent: result?.content,
    lowerText: blockSearchableText(block, toolResultMap).toLowerCase(),
    needle: "",
    count: 0,
  };
}
