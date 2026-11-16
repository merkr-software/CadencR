import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PersistedIdSet } from "@/hooks/usePersistedIdSet";

/**
 * In-memory `usePersistedIdSet` for component tests that don't run the
 * workspace-settings queries: the stored value is shared by every hook on the
 * same key, like the real query cache.
 */
const sets = new Map<string, ReadonlySet<number>>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<number> = new Set();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetPersistedIdSets(initial: Record<string, number[]> = {}): void {
  sets.clear();
  for (const [key, ids] of Object.entries(initial)) sets.set(key, new Set(ids));
  listeners.forEach((listener) => listener());
}

/** What a test would find persisted under `key`, sorted. */
export function persistedIds(key: string): number[] {
  return [...(sets.get(key) ?? EMPTY)].sort((a, b) => a - b);
}

export function usePersistedIdSet(key: string): PersistedIdSet {
  const ids = useSyncExternalStore(subscribe, () => sets.get(key) ?? EMPTY);
  const setMember = useCallback(
    (id: number, member: boolean): void => {
      const next = new Set(sets.get(key) ?? EMPTY);
      if (next.has(id) === member) return;
      if (member) next.add(id);
      else next.delete(id);
      sets.set(key, next);
      listeners.forEach((listener) => listener());
    },
    [key],
  );
  return useMemo(() => ({ ids, setMember }), [ids, setMember]);
}
