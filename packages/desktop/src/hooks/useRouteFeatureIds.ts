import { useRouterState } from "@tanstack/react-router";

const ROUTE_IDS = /\/projects\/(\d+)(?:\/features\/(\d+))?/;

/**
 * The project and conversation the current route shows, from its path or search
 * params. Selects plain values, so other router updates don't re-render callers.
 */
export function useRouteFeatureIds(): {
  projectId: number | null;
  featureId: number | null;
} {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchProjectId = useRouterState({ select: (state) => state.location.search?.projectId });
  const searchFeatureId = useRouterState({ select: (state) => state.location.search?.featureId });
  const routeParams = (pathname.match(ROUTE_IDS) ?? []) as string[];
  const projectId = routeParams[1]
    ? Number(routeParams[1])
    : searchProjectId
      ? Number(searchProjectId)
      : null;
  const featureId = routeParams[2]
    ? Number(routeParams[2])
    : searchFeatureId
      ? Number(searchFeatureId)
      : null;
  return { projectId, featureId };
}
