import type { WsSessionSearch } from "@/routes/-ws-session-search";
import type { TabKind } from "@/stores/feature-layout-schema";

/** A spot the user settled on: a plain page, or a conversation and its focused tab. */
export type NavigationEntry =
  | { kind: "page"; href: string }
  | {
      kind: "session";
      sessionId: string;
      search: Omit<WsSessionSearch, "focusTab">;
      tab: TabKind | null;
    };

// Bounds memory over a long-running app session; the oldest entries fall off.
const MAX_ENTRIES = 100;

function entryKey(entry: NavigationEntry): string {
  return entry.kind === "page" ? entry.href : `session:${entry.sessionId}:${entry.tab ?? ""}`;
}

/**
 * Browser-style back/forward stack. `record` appends where the user settled,
 * dropping any forward entries; `go` moves the cursor and returns the entry to
 * restore. Until the router reaches that entry (`arrive`) or a spot settles
 * (`record`), the jump is still landing, so a further `go` must not record the
 * in-between location.
 */
export function createNavigationHistory() {
  let entries: NavigationEntry[] = [];
  let index = -1;
  // Target of a jump the router has not reached yet.
  let landing: NavigationEntry | null = null;

  function record(entry: NavigationEntry): void {
    landing = null;
    const current = entries[index];
    // Same spot: keep its position but take the latest search (e.g. a new cwd).
    if (current && entryKey(current) === entryKey(entry)) {
      entries[index] = entry;
      return;
    }
    entries = [...entries.slice(0, index + 1), entry].slice(-MAX_ENTRIES);
    index = entries.length - 1;
  }

  // Once the jump lands, any later move is the user's own and must be recorded.
  function arrive(entry: NavigationEntry): void {
    if (landing && entryKey(landing) === entryKey(entry)) landing = null;
  }

  function go(delta: -1 | 1, from: NavigationEntry): NavigationEntry | null {
    if (!landing) record(from);
    const target = entries[index + delta];
    if (!target) return null;
    index += delta;
    landing = target;
    return target;
  }

  return { arrive, record, go };
}
