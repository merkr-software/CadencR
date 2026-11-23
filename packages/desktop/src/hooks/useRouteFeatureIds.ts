import { useMemo } from "react";
import { useRouterState } from "@tanstack/react-router";

const ROUTE_IDS = /\/projects\/(\d+)(?:\/features\/(\d+))?/;

/** An id from the path's `/projects/:id/features/:id` segments, else from the search param. */
function routeId(pathname: string, group: 1 | 2, searchValue: unknown): number | null {
  const fromPath = pathname.match(ROUTE_IDS)?.[group];
  if (fromPath) return Number(fromPath);
  return searchValue ? Number(searchValue) : null;
}

/**
 * The project the current route shows. The selector returns the id itself, so
 * a navigation that keeps the project (another of its conversations, another
 * tab) doesn't re-render the caller.
 */
export function useRouteProjectId(): number | null {
  return useRouterState({
    select: (state) => routeId(state.location.pathname, 1, state.location.search?.projectId),
  });
}

/** The conversation the current route shows; re-renders the caller only when it changes. */
export function useRouteFeatureId(): number | null {
  return useRouterState({
    select: (state) => routeId(state.location.pathname, 2, state.location.search?.featureId),
  });
}

/**
 * The project and conversation the current route shows, from its path or search
 * params. Selects plain values, so other router updates don't re-render callers,
 * and returns the same object until one of them changes.
 */
export function useRouteFeatureIds(): {
  projectId: number | null;
  featureId: number | null;
} {
  const projectId = useRouteProjectId();
  const featureId = useRouteFeatureId();
  return useMemo(() => ({ projectId, featureId }), [projectId, featureId]);
}
