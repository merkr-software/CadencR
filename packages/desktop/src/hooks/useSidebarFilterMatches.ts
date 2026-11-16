import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  FeatureStatus,
  getListFeaturesQueryOptions,
  getListFeatureWorktreesQueryOptions,
  type Feature,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { useLiveFeatureMeta } from "@/hooks/useLiveFeatureMeta";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  featureMatchesSidebarFilter,
  matchesSidebarFilter,
  sidebarFilterTerms,
} from "@/lib/sidebar-filter";
import { FEATURE_WORKTREES_STALE_MS, featureActivityParams } from "@/lib/sidebar-queries";

export interface FilterableProject {
  id: number;
  name: string;
}

/**
 * Which part of a project the filter keeps: `null` when the project's own name
 * matched (all of it shows), else the ids of its matching conversations.
 */
export type ProjectFilterMatch = ReadonlySet<number> | null;

interface SidebarFilterMatches {
  /** Projects with something to show, in the order given. */
  matches: ReadonlyMap<number, ProjectFilterMatch>;
  isLoading: boolean;
}

interface QueryResult<T> {
  data?: T;
  error: unknown;
  isPending: boolean;
}

// Module-level so TanStack can memoize the combined results between renders.
function combineLists<T>(results: QueryResult<T[]>[]) {
  return {
    lists: results.map((result) => result.data ?? []),
    isLoading: results.some((result) => result.isPending),
    error: results.find((result) => result.error)?.error ?? null,
  };
}

/**
 * Filters every project's conversations, collapsed projects included. Uses the
 * project sections' own query keys, so the lists an expanded project already
 * holds are reused and the ones fetched here serve the rows it then renders.
 * Pinned and archived conversations are left out: the pinned section filters
 * its own rows, and archives stay out of a quick filter.
 */
export function useSidebarFilterMatches(
  projects: readonly FilterableProject[],
  query: string,
): SidebarFilterMatches {
  const features = useQueries({
    queries: projects.map((project) =>
      getListFeaturesQueryOptions(featureActivityParams(project.id)),
    ),
    combine: combineLists<Feature>,
  });
  const worktrees = useQueries({
    queries: projects.map((project) =>
      getListFeatureWorktreesQueryOptions(
        { project_id: project.id },
        { query: { staleTime: FEATURE_WORKTREES_STALE_MS } },
      ),
    ),
    combine: combineLists<FeatureWorktreeInfo>,
  });
  const liveMeta = useLiveFeatureMeta();
  const error = features.error ?? worktrees.error;

  useEffect(() => {
    if (!error) return;
    toast.error(apiErrorMessage(error, "Failed to load conversations to filter"), {
      id: "sidebar-filter-load-error",
    });
  }, [error]);

  // Typing stays responsive on large workspaces; matching catches up.
  const deferredQuery = useDeferredValue(query);
  const terms = useMemo(() => sidebarFilterTerms(deferredQuery), [deferredQuery]);
  const previous = useRef<ReadonlyMap<number, ProjectFilterMatch>>(new Map());
  const matches = useMemo(() => {
    const result = new Map<number, ProjectFilterMatch>();
    projects.forEach((project, index) => {
      if (matchesSidebarFilter(terms, [project.name])) {
        result.set(project.id, null);
        return;
      }
      const worktreeByFeatureId = new Map(
        (worktrees.lists[index] ?? []).map((worktree) => [worktree.feature_id, worktree]),
      );
      const ids = new Set<number>();
      for (const feature of features.lists[index] ?? []) {
        if (feature.status !== FeatureStatus.active || feature.is_pinned) continue;
        const worktree = worktreeByFeatureId.get(feature.id);
        if (featureMatchesSidebarFilter(terms, feature, liveMeta, worktree)) ids.add(feature.id);
      }
      // Keep last keystroke's set when nothing changed, so the project's rows
      // and hierarchy are not rebuilt.
      const before = previous.current.get(project.id);
      if (ids.size > 0) result.set(project.id, before && sameIds(before, ids) ? before : ids);
    });
    return result;
  }, [features.lists, liveMeta, projects, terms, worktrees.lists]);
  useEffect(() => {
    previous.current = matches;
  }, [matches]);

  return { matches, isLoading: features.isLoading || worktrees.isLoading };
}

function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
