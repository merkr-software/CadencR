import { differenceInCalendarDays } from "date-fns";
import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import { parseUTCDateTime } from "@/lib/date-utils";
import { normalizeLabel } from "@/lib/feature-labels";
import { getFileName } from "@/lib/file-language";
import type { AttentionState } from "@/lib/sidebar-attention";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { sortByManualOrder } from "@/lib/sidebar-manual-order";

export type SidebarLens = SidebarConfig["lens"];
export type ConversationSort = SidebarConfig["conversationSort"];
/** The lenses that regroup conversations across projects, in a single list. */
export type CrossProjectLens = Exclude<SidebarLens, "project">;

/** One group of a cross-project lens: its header names `value` (null: none of it). */
export interface LensGroup {
  key: string;
  lens: CrossProjectLens;
  value: string | null;
  features: readonly Feature[];
}

export interface LensContext {
  stateOf: (featureId: number) => AttentionState;
  worktreeOf: (featureId: number) => FeatureWorktreeInfo | undefined;
  now: number;
}

/** Most urgent first, the way the For me block reads. */
export const STATUS_GROUP_ORDER: readonly AttentionState[] = [
  "waiting",
  "failed",
  "working",
  "unread",
  "idle",
];

export const DATE_GROUP_ORDER = ["today", "yesterday", "week", "older"] as const;
export type DateGroup = (typeof DATE_GROUP_ORDER)[number];

/** A conversation's last activity: its last prompt, else its creation (SQLite UTC text). */
export function lastActivityOf(feature: Feature): string {
  return feature.last_activity_at ?? feature.created_at;
}

/** Names compared as people read them: case-blind, "v10" after "v9". */
export const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Newest first by a timestamp column; SQLite's fixed-width text compares in time order. */
export function newestFirst(key: (feature: Feature) => string) {
  return (a: Feature, b: Feature): number => {
    const left = key(a);
    const right = key(b);
    return left < right ? 1 : left > right ? -1 : 0;
  };
}

const createdAtOf = (feature: Feature): string => feature.created_at;

/**
 * Orders conversations per the "Sort conversations" option. "activity" keeps
 * the given order: every list arrives last-activity first, and the project
 * tree holds that order steady while agents work. "manual" follows the rank
 * the user dragged into place (`manualOrder`, see `sidebar-manual-order.ts`).
 */
export function sortConversations(
  features: readonly Feature[],
  sort: ConversationSort,
  manualOrder: readonly number[],
): readonly Feature[] {
  if (sort === "activity") return features;
  if (sort === "manual") return sortByManualOrder(features, manualOrder);
  const sorted = [...features];
  if (sort === "created") sorted.sort(newestFirst(createdAtOf));
  else sorted.sort((a, b) => NAME_COLLATOR.compare(a.title, b.title));
  return sorted;
}

function dateGroupOf(feature: Feature, now: number): DateGroup {
  const days = differenceInCalendarDays(now, parseUTCDateTime(lastActivityOf(feature)));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/** A worktree conversation's branch (its folder when detached); null in the project checkout. */
function worktreeNameOf(info: FeatureWorktreeInfo | undefined): string | null {
  if (!info || info.is_main_worktree) return null;
  return info.worktree_branch ?? getFileName(info.worktree_path);
}

function valueOf(feature: Feature, lens: CrossProjectLens, context: LensContext): string | null {
  switch (lens) {
    case "status":
      return context.stateOf(feature.id);
    case "worktree":
      return worktreeNameOf(context.worktreeOf(feature.id));
    case "provider":
      return feature.runtime_provider ?? null;
    case "label":
      return normalizeLabel(feature.label ?? "");
    case "date":
      return dateGroupOf(feature, context.now);
    case "flat":
      return "all";
  }
}

/** Fixed orders for the lenses that have one; the rest follow their newest conversation. */
function fixedOrder(lens: CrossProjectLens): readonly string[] | null {
  if (lens === "status") return STATUS_GROUP_ORDER;
  if (lens === "date") return DATE_GROUP_ORDER;
  return null;
}

/**
 * Groups conversations for a cross-project lens. Within a group they keep
 * their given order (sort them first). Groups without a fixed order come in
 * the order of their first conversation, the "none" group (no worktree, no
 * label…) last. Empty groups are left out.
 */
export function groupConversations(
  features: readonly Feature[],
  lens: CrossProjectLens,
  context: LensContext,
): readonly LensGroup[] {
  const byValue = new Map<string | null, Feature[]>();
  for (const feature of features) {
    const value = valueOf(feature, lens, context);
    const group = byValue.get(value);
    if (group) group.push(feature);
    else byValue.set(value, [feature]);
  }
  const order = fixedOrder(lens);
  const values = order
    ? order.filter((value) => byValue.has(value))
    : [...byValue.keys()].sort((a, b) => Number(a === null) - Number(b === null));
  return values.map((value) => ({
    key: `${lens}:${value ?? ""}`,
    lens,
    value,
    features: byValue.get(value) ?? [],
  }));
}
