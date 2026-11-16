import { useCallback, useMemo, useState } from "react";
import type { UnifiedAgentEntry } from "@/api/generated";

/** What makes an agent move in the sorted order: its sort inputs. */
export type AgentSortSignature = (entry: UnifiedAgentEntry) => string;

interface FrozenOrder {
  key: string;
  ids: number[];
  signatures: ReadonlyMap<number, string>;
}

export interface StableAgentOrder {
  agents: UnifiedAgentEntry[];
  /** Agents whose signature changed (or that appeared) since the order was
   *  taken, while the shown order no longer matches the sorted one; 0 when it
   *  does. A drift no signature explains stays silent. */
  pendingChanges: number;
  /** Adopt the current sorted order. */
  resort: () => void;
}

const sessionIdOf = (entry: UnifiedAgentEntry): number => entry.session.sessionDbId;

/**
 * Keeps the grid's order still while agents change state underneath it: a
 * card never jumps away from the pointer or the reader. The order is taken
 * once per `resetKey` (a filter or sort change re-takes it); afterwards cards
 * keep their slot, removed agents drop out, and new ones join at the end.
 * When that order drifts from the sorted one, `pendingChanges` counts the
 * agents behind the drift so the view can offer a re-sort.
 */
export function useStableAgentOrder(
  sorted: UnifiedAgentEntry[],
  signatureOf: AgentSortSignature,
  resetKey: string,
  ready: boolean,
): StableAgentOrder {
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null);
  let current = frozen?.key === resetKey ? frozen : null;
  // Take the order during render (React's "adjust state on prop change"
  // pattern), so a new filter never paints once unfrozen and then again.
  if (!current && ready) {
    current = freezeOrder(resetKey, sorted, signatureOf);
    setFrozen(current);
  }

  const view = useMemo(
    () =>
      current ? applyFrozenOrder(sorted, current, signatureOf) : { agents: sorted, changes: 0 },
    [current, signatureOf, sorted],
  );

  const resort = useCallback((): void => {
    setFrozen(freezeOrder(resetKey, sorted, signatureOf));
  }, [resetKey, signatureOf, sorted]);

  return useMemo(
    () => ({ agents: view.agents, pendingChanges: view.changes, resort }),
    [resort, view],
  );
}

function freezeOrder(
  key: string,
  sorted: UnifiedAgentEntry[],
  signatureOf: AgentSortSignature,
): FrozenOrder {
  return {
    key,
    ids: sorted.map(sessionIdOf),
    signatures: new Map(sorted.map((entry) => [sessionIdOf(entry), signatureOf(entry)])),
  };
}

function applyFrozenOrder(
  sorted: UnifiedAgentEntry[],
  frozen: FrozenOrder,
  signatureOf: AgentSortSignature,
): { agents: UnifiedAgentEntry[]; changes: number } {
  const byId = new Map(sorted.map((entry) => [sessionIdOf(entry), entry]));
  const kept: UnifiedAgentEntry[] = [];
  for (const id of frozen.ids) {
    const entry = byId.get(id);
    if (entry) kept.push(entry);
  }
  const keptIds = new Set(kept.map(sessionIdOf));
  const agents = [...kept, ...sorted.filter((entry) => !keptIds.has(sessionIdOf(entry)))];
  if (agents.every((entry, index) => entry === sorted[index]))
    return { agents: sorted, changes: 0 };
  const changes = agents.filter(
    (entry) => frozen.signatures.get(sessionIdOf(entry)) !== signatureOf(entry),
  ).length;
  return { agents, changes };
}
