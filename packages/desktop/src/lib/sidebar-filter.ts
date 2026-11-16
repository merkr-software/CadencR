import type { Feature, FeatureWorktreeInfo } from "@/api/generated";
import type { LiveFeatureMetaMap } from "@/hooks/useLiveFeatureMeta";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";

/** A filter query as lowercased terms; none means everything matches. */
export function sidebarFilterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether every term appears, case-insensitive, in at least one of `texts`.
 * `fix login` finds "Fix the login redirect".
 */
export function matchesSidebarFilter(
  terms: readonly string[],
  texts: readonly (string | null | undefined)[],
): boolean {
  const haystack = texts
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Whether a conversation matches by its live title, title, label or branch. */
export function featureMatchesSidebarFilter(
  terms: readonly string[],
  feature: Feature,
  liveMeta: LiveFeatureMetaMap,
  worktree: FeatureWorktreeInfo | undefined,
): boolean {
  return matchesSidebarFilter(terms, [
    liveMeta[wsSessionIdFromFeature(feature.id)]?.featureTitle,
    feature.title,
    feature.label,
    worktree?.worktree_branch,
  ]);
}
