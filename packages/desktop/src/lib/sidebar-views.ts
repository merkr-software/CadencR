import { z } from "zod";
import type { Feature, Project } from "@/api/generated";
import {
  parseUnifiedAgentsFilterText,
  tokenizeFilterText,
} from "@/components/UnifiedAgentsFilterLanguage";
import type { UnifiedAgentsSortOrder } from "@/components/UnifiedAgentsFilterState";
import {
  isTruthyFilterValue,
  normalizeFilterValue,
  splitFilterValues,
} from "@/components/unified-agents-filter-values";
import { parseUTCDateTime } from "@/lib/date-utils";
import { parseJsonSetting } from "@/lib/json-setting";
import type { AttentionState } from "@/lib/sidebar-attention";
import {
  groupConversations,
  lastActivityOf,
  newestFirst,
  sortConversations,
  STATUS_GROUP_ORDER,
  type ConversationSort,
  type CrossProjectLens,
  type LensContext,
  type LensGroup,
  type SidebarLens,
} from "@/lib/sidebar-lens";

/** Workspace settings: the saved views (JSON) and the id of the one shown ("" for none). */
export const SIDEBAR_VIEWS_KEY = "sidebar_views";
export const SIDEBAR_ACTIVE_VIEW_KEY = "sidebar_active_view";

const viewSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  query: z.string(),
});

/** A saved sidebar view: a name and a query in the Agents grid filter language. */
export type SidebarView = z.infer<typeof viewSchema>;

export function parseSidebarViews(raw: string | null | undefined): {
  views: SidebarView[];
  error: string | null;
} {
  const parsed = parseJsonSetting(raw, z.array(viewSchema), "expected a list of {id, name, query}");
  return { views: parsed.value ?? [], error: parsed.error };
}

/** The keys a sidebar view adds to the Agents grid's (`/last:`, `/project:`, `/sort:`, `/exclude:`, `/pin:`). */
const SIDEBAR_KEYS = ["status", "label", "provider", "worktree"] as const;
type SidebarKey = (typeof SIDEBAR_KEYS)[number];

export interface SidebarViewFilter {
  /** Last activity within this many minutes, or still busy; null when the query sets no `/last:`. */
  freshMinutes: number | null;
  projectIds: readonly number[];
  excludedTitles: readonly string[];
  pinnedOnly: boolean;
  text: string;
  sortOrder: UnifiedAgentsSortOrder | null;
  statuses: readonly AttentionState[];
  /** Lowercased; "none" asks for conversations without one. */
  labels: readonly string[];
  providers: readonly string[];
  worktree: boolean | null;
}

function values(raw: string): string[] {
  return splitFilterValues(raw)
    .map((value) => normalizeFilterValue(value).toLowerCase())
    .filter(Boolean);
}

function sidebarPair(token: string): { key: SidebarKey; value: string } | null {
  const match = /^\/(\w+):(.*)$/.exec(token);
  const key = match?.[1]?.toLowerCase();
  const found = SIDEBAR_KEYS.find((candidate) => candidate === key);
  return found && match ? { key: found, value: match[2] ?? "" } : null;
}

/** Reads a view's query: the Agents grid's keys through its own parser, plus the sidebar's. */
export function parseSidebarViewQuery(
  query: string,
  projects: readonly Project[],
): SidebarViewFilter {
  const filter = {
    statuses: [] as AttentionState[],
    labels: [] as string[],
    providers: [] as string[],
    worktree: null as boolean | null,
  };
  const rest: string[] = [];
  let hasLast = false;
  let hasSort = false;
  for (const token of tokenizeFilterText(query)) {
    const pair = sidebarPair(token.text);
    const gridKey = token.pair?.key;
    hasLast ||= gridKey === "last";
    hasSort ||= gridKey === "sort";
    if (!pair) rest.push(token.text);
    else if (pair.key === "status") {
      filter.statuses = STATUS_GROUP_ORDER.filter((state) => values(pair.value).includes(state));
    } else if (pair.key === "label") filter.labels = values(pair.value);
    else if (pair.key === "provider") filter.providers = values(pair.value);
    else filter.worktree = isTruthyFilterValue(pair.value) || values(pair.value)[0] === "yes";
  }
  const grid = parseUnifiedAgentsFilterText(rest.join(" "), [...projects]);
  return {
    ...filter,
    freshMinutes: hasLast && grid.mode === "recent" ? grid.freshMinutes : null,
    projectIds: grid.projectIds,
    excludedTitles: grid.excludedTitles.map((title) => title.toLowerCase()),
    pinnedOnly: grid.pinnedOnly,
    text: grid.query.toLowerCase(),
    sortOrder: hasSort ? grid.sortOrder : null,
  };
}

function matches(feature: Feature, filter: SidebarViewFilter, context: LensContext): boolean {
  const state = context.stateOf(feature.id);
  const title = feature.title.toLowerCase();
  const label = feature.label?.trim().toLowerCase() || "none";
  const provider = feature.runtime_provider?.toLowerCase() ?? "";
  const worktree = context.worktreeOf(feature.id);
  const inWorktree = worktree !== undefined && !worktree.is_main_worktree;
  const busy = state === "working" || state === "waiting";
  const fresh =
    filter.freshMinutes === null ||
    busy ||
    context.now - parseUTCDateTime(lastActivityOf(feature)).getTime() <=
      filter.freshMinutes * 60_000;
  return (
    fresh &&
    (filter.projectIds.length === 0 || filter.projectIds.includes(feature.project_id)) &&
    !filter.excludedTitles.some((excluded) => title.includes(excluded)) &&
    (!filter.pinnedOnly || feature.is_pinned) &&
    title.includes(filter.text) &&
    (filter.statuses.length === 0 || filter.statuses.includes(state)) &&
    (filter.labels.length === 0 || filter.labels.includes(label)) &&
    (filter.providers.length === 0 || filter.providers.some((p) => provider.includes(p))) &&
    (filter.worktree === null || filter.worktree === inWorktree)
  );
}

function sortForView(
  features: Feature[],
  order: UnifiedAgentsSortOrder | null,
): readonly Feature[] {
  if (order === null) return features;
  const newest = newestFirst(order.startsWith("created") ? (f) => f.created_at : lastActivityOf);
  return features.sort(order.endsWith("_asc") ? (a, b) => newest(b, a) : newest);
}

/** The conversations a view shows, in its `/sort:` order (else the given one). */
export function applySidebarView(
  features: readonly Feature[],
  filter: SidebarViewFilter,
  context: LensContext,
): readonly Feature[] {
  return sortForView(
    features.filter((feature) => matches(feature, filter, context)),
    filter.sortOrder,
  );
}

/** What the sidebar lists below its blocks: the project tree, a cross-project lens, or a view. */
export type SidebarListMode =
  | { kind: "tree" }
  | { kind: "lens"; lens: CrossProjectLens }
  | { kind: "view"; view: SidebarView };

export function sidebarListMode(lens: SidebarLens, view: SidebarView | null): SidebarListMode {
  if (view) return { kind: "view", view };
  return lens === "project" ? { kind: "tree" } : { kind: "lens", lens };
}

/** Whether a cross-project list names its groups: a view and the flat lens are one unnamed list. */
export function showsGroupHeaders(mode: SidebarListMode): boolean {
  return mode.kind === "lens" && mode.lens !== "flat";
}

/**
 * The groups a cross-project list shows. A lens leaves pinned conversations to
 * the Pinned block, as the tree does; a view's query decides for itself.
 */
export function buildSidebarGroups(
  features: readonly Feature[],
  mode: Exclude<SidebarListMode, { kind: "tree" }>,
  sort: ConversationSort,
  manualOrder: readonly number[],
  projects: readonly Project[],
  context: LensContext,
): readonly LensGroup[] {
  if (mode.kind === "view") {
    const filter = parseSidebarViewQuery(mode.view.query, projects);
    const shown = applySidebarView(sortConversations(features, sort, manualOrder), filter, context);
    return [{ key: `view:${mode.view.id}`, lens: "flat", value: null, features: shown }];
  }
  const unpinned = features.filter((feature) => !feature.is_pinned);
  return groupConversations(sortConversations(unpinned, sort, manualOrder), mode.lens, context);
}

/**
 * Whether dragging can reorder a cross-project list's rows: a view with its
 * own `/sort:` keeps that order, so a drop there would change nothing visible.
 */
export function isSidebarListReorderable(
  mode: Exclude<SidebarListMode, { kind: "tree" }>,
  projects: readonly Project[],
): boolean {
  return (
    mode.kind !== "view" || parseSidebarViewQuery(mode.view.query, projects).sortOrder === null
  );
}
