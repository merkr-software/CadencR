import type { useNavigate } from "@tanstack/react-router";
import {
  getGetFeatureQueryKey,
  getListActiveFeaturesQueryKey,
  getListFeaturesQueryKey,
  getListPinnedFeaturesQueryKey,
  getListProjectsQueryKey,
  getListRecentFeaturesQueryKey,
  type Feature,
  type Project,
} from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import type { TabKind } from "@/stores/feature-layout-schema";

type NavigateFn = ReturnType<typeof useNavigate>;

export interface ConversationRouteOptions {
  /** A tab to bring forward in the conversation opened. */
  focusTab?: TabKind;
  /** The project's path, when the caller has it; otherwise read from the projects cache. */
  cwd?: string;
  /** The caller holds the feature itself (a sidebar row, a create mutation's result). */
  featureKnown?: boolean;
}

/** Where opening a conversation navigates: its workspace, or the legacy page that resolves it. */
export type ConversationRoute =
  | {
      to: "/ws-session/$sessionId";
      params: { sessionId: string };
      search: { cwd: string; featureId: number; projectId: number; focusTab?: TabKind };
    }
  | {
      to: "/projects/$projectId/features/$featureId";
      params: { projectId: string; featureId: string };
      search?: { focusTab: TabKind };
    };

/** The lists the sidebar, the palette and the conversation pages keep features in. */
function featureListKeys(): readonly (readonly unknown[])[] {
  return [
    getListFeaturesQueryKey(),
    getListPinnedFeaturesQueryKey(),
    getListActiveFeaturesQueryKey(),
    getListRecentFeaturesQueryKey(),
  ];
}

function isCachedFeature(featureId: number): boolean {
  // A detail query that failed (a 404 for a deleted conversation) proves nothing,
  // whatever data it held before.
  const detail = queryClient.getQueryState<Feature>(getGetFeatureQueryKey(featureId));
  if (detail?.status === "success" && detail.data?.id === featureId) return true;
  return featureListKeys().some((queryKey) =>
    queryClient
      .getQueriesData<unknown>({ queryKey })
      .some(
        ([, data]) =>
          Array.isArray(data) && data.some((feature: Feature) => feature.id === featureId),
      ),
  );
}

function cachedProjectPath(projectId: number): string | undefined {
  return queryClient
    .getQueryData<Project[]>(getListProjectsQueryKey())
    ?.find((project) => project.id === projectId)?.path;
}

/**
 * The route that opens a conversation. Straight to its workspace when what that
 * route needs is in memory: the project's path, and a feature known to exist
 * (in a cached list or feature query, or vouched for by the caller). Otherwise
 * the legacy feature page, which fetches the feature, resolves the path and
 * says "not found" for a deleted one.
 *
 * Going through that page unmounts the conversation page, and with it every
 * workspace the pool keeps mounted (`WorkspacePool`): from a conversation, the
 * direct route is what keeps the next open instant.
 */
export function conversationRoute(
  projectId: number,
  featureId: number,
  options: ConversationRouteOptions = {},
): ConversationRoute {
  const { focusTab } = options;
  const cwd = options.cwd ?? cachedProjectPath(projectId);
  if (cwd !== undefined && (options.featureKnown === true || isCachedFeature(featureId))) {
    return {
      to: "/ws-session/$sessionId",
      params: { sessionId: wsSessionIdFromFeature(featureId) },
      search: focusTab ? { cwd, featureId, projectId, focusTab } : { cwd, featureId, projectId },
    };
  }
  const params = { projectId: String(projectId), featureId: String(featureId) };
  return focusTab
    ? { to: "/projects/$projectId/features/$featureId", params, search: { focusTab } }
    : { to: "/projects/$projectId/features/$featureId", params };
}

/** Navigate to `conversationRoute(projectId, featureId, options)`. */
export function navigateToConversation(
  navigate: NavigateFn,
  projectId: number,
  featureId: number,
  options?: ConversationRouteOptions,
): void {
  const route = conversationRoute(projectId, featureId, options);
  if (route.to === "/ws-session/$sessionId") void navigate(route);
  else void navigate(route);
}
