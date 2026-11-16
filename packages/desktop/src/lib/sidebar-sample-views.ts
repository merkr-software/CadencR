import type { Feature, PrStatusSnapshot } from "@/api/generated";
import {
  countByProject,
  type ResolvedAttention,
  type ResolvedAttentionResult,
} from "@/hooks/useResolvedAttention";
import { buildAttentionIndex } from "@/lib/attention-index";
import { deriveNextActions, type NextActionKind } from "@/lib/next-actions";
import { needsUser, type AttentionState } from "@/lib/sidebar-attention";
import { lastActivityOf, newestFirst } from "@/lib/sidebar-lens";
import type { SampleConversation } from "@/lib/sidebar-sample-data";

/** A sample conversation with the state it shows right now. */
export interface SampleRow {
  conversation: SampleConversation;
  state: AttentionState;
}

/** A "For me" sample: the row and what it asks the user to do. */
export interface SampleAction {
  row: SampleRow;
  kind: NextActionKind;
}

export interface SampleViews {
  /** What the collapsed rail, the folded projects' badges and For me read, as the live sidebar resolves it. */
  attention: ResolvedAttentionResult;
  forMe: readonly SampleAction[];
  working: readonly SampleRow[];
  recent: readonly SampleRow[];
  pinned: readonly SampleRow[];
}

function lastActivity(row: SampleRow): string {
  return lastActivityOf(row.conversation.feature);
}

/** The samples' conversations, last activity first: the order every list arrives in. */
export function byActivity(rows: readonly SampleRow[]): Feature[] {
  return rows.map((row) => row.conversation.feature).sort(newestFirst(lastActivityOf));
}

/** Everything the blocks, the folded projects and the rail show, picked the way the live sidebar picks it. */
export function sampleViews(rows: readonly SampleRow[], recentCount: number): SampleViews {
  const oldestFirst = [...rows].sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)));
  const ids = (state: AttentionState) =>
    oldestFirst.filter((row) => row.state === state).map((row) => row.conversation.feature.id);
  const entries = buildAttentionIndex(
    { waiting: ids("waiting"), working: ids("working") },
    { failed: ids("failed"), unread: ids("unread") },
  );
  const byId = new Map(rows.map((row) => [row.conversation.feature.id, row]));
  const items = entries.flatMap((entry): ResolvedAttention[] => {
    const row = byId.get(entry.featureId);
    return row ? [{ feature: row.conversation.feature, state: entry.state }] : [];
  });
  const queue = items.filter((item) => needsUser(item.state));
  const rowsOf = (list: readonly ResolvedAttention[]) =>
    list.flatMap((item) => byId.get(item.feature.id) ?? []);
  const forMe = deriveNextActions(entries, pullRequests(rows)).flatMap((action) => {
    const row = byId.get(action.featureId);
    return row ? [{ row, kind: action.kind }] : [];
  });
  const actions = forMe.map(({ row, kind }) => ({ feature: row.conversation.feature, kind }));
  return {
    attention: {
      entries,
      items,
      queue,
      byProject: countByProject(items),
      loadingStates: [],
      actions,
      actionsLoading: false,
    },
    forMe,
    working: rowsOf(items.filter((item) => item.state === "working")),
    recent: oldestFirst.slice(Math.max(0, oldestFirst.length - recentCount)).reverse(),
    pinned: rows.filter((row) => row.conversation.feature.is_pinned),
  };
}

function pullRequests(rows: readonly SampleRow[]): Record<number, PrStatusSnapshot> {
  return Object.fromEntries(
    rows.flatMap(({ conversation }) =>
      conversation.prStatus ? [[conversation.feature.id, conversation.prStatus]] : [],
    ),
  );
}
